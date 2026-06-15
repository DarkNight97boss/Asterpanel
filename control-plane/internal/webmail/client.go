// Package webmail is the panel's IMAP/SMTP gateway: it connects to the mail
// server on behalf of a mailbox so the native webmail UI never speaks IMAP
// directly. This is the modern, integrated alternative to bolting on Roundcube.
package webmail

import (
	"bytes"
	"crypto/tls"
	"errors"
	"io"
	"mime"
	"net/smtp"
	"strings"
	"time"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
	gomail "github.com/emersion/go-message/mail"
)

type Config struct {
	IMAPAddr string
	SMTPAddr string
	IMAPTLS  bool
	SMTPTLS  bool
}

type Service struct{ cfg Config }

func New(cfg Config) *Service { return &Service{cfg: cfg} }

// Configured reports whether a mail server address is set.
func (s *Service) Configured() bool { return s.cfg.IMAPAddr != "" }

func (s *Service) connect(user, pass string) (*client.Client, error) {
	var (
		c   *client.Client
		err error
	)
	if s.cfg.IMAPTLS {
		c, err = client.DialTLS(s.cfg.IMAPAddr, &tls.Config{ServerName: hostOnly(s.cfg.IMAPAddr)})
	} else {
		c, err = client.Dial(s.cfg.IMAPAddr)
	}
	if err != nil {
		return nil, err
	}
	if err := c.Login(user, pass); err != nil {
		_ = c.Logout()
		return nil, err
	}
	return c, nil
}

type Folder struct {
	Name string `json:"name"`
}

func (s *Service) Folders(user, pass string) ([]Folder, error) {
	c, err := s.connect(user, pass)
	if err != nil {
		return nil, err
	}
	defer c.Logout()

	ch := make(chan *imap.MailboxInfo, 20)
	done := make(chan error, 1)
	go func() { done <- c.List("", "*", ch) }()
	var out []Folder
	for m := range ch {
		out = append(out, Folder{Name: m.Name})
	}
	if err := <-done; err != nil {
		return nil, err
	}
	return out, nil
}

type MessageHeader struct {
	UID     uint32 `json:"uid"`
	From    string `json:"from"`
	Subject string `json:"subject"`
	Date    string `json:"date"`
	Seen    bool   `json:"seen"`
}

func (s *Service) Messages(user, pass, folder string, limit uint32) ([]MessageHeader, error) {
	c, err := s.connect(user, pass)
	if err != nil {
		return nil, err
	}
	defer c.Logout()

	mbox, err := c.Select(folder, true)
	if err != nil {
		return nil, err
	}
	if mbox.Messages == 0 {
		return nil, nil
	}
	from := uint32(1)
	if mbox.Messages > limit {
		from = mbox.Messages - limit + 1
	}
	seqset := new(imap.SeqSet)
	seqset.AddRange(from, mbox.Messages)

	ch := make(chan *imap.Message, limit)
	done := make(chan error, 1)
	go func() {
		done <- c.Fetch(seqset, []imap.FetchItem{imap.FetchEnvelope, imap.FetchFlags, imap.FetchUid}, ch)
	}()
	var out []MessageHeader
	for msg := range ch {
		if msg.Envelope == nil {
			continue
		}
		out = append(out, MessageHeader{
			UID:     msg.Uid,
			From:    fromString(msg.Envelope),
			Subject: msg.Envelope.Subject,
			Date:    msg.Envelope.Date.UTC().Format(time.RFC3339),
			Seen:    hasFlag(msg.Flags, imap.SeenFlag),
		})
	}
	if err := <-done; err != nil {
		return nil, err
	}
	// Newest first.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

type MessageBody struct {
	UID      uint32 `json:"uid"`
	From     string `json:"from"`
	Subject  string `json:"subject"`
	Date     string `json:"date"`
	BodyText string `json:"body_text"`
	BodyHTML string `json:"body_html"`
}

func (s *Service) Message(user, pass, folder string, uid uint32) (*MessageBody, error) {
	c, err := s.connect(user, pass)
	if err != nil {
		return nil, err
	}
	defer c.Logout()

	if _, err := c.Select(folder, false); err != nil {
		return nil, err
	}
	seqset := new(imap.SeqSet)
	seqset.AddNum(uid)
	section := &imap.BodySectionName{}

	ch := make(chan *imap.Message, 1)
	done := make(chan error, 1)
	go func() {
		done <- c.UidFetch(seqset, []imap.FetchItem{imap.FetchEnvelope, section.FetchItem()}, ch)
	}()
	msg := <-ch
	if err := <-done; err != nil {
		return nil, err
	}
	if msg == nil {
		return nil, errors.New("message not found")
	}

	out := &MessageBody{
		UID:     uid,
		Subject: msg.Envelope.Subject,
		From:    fromString(msg.Envelope),
		Date:    msg.Envelope.Date.UTC().Format(time.RFC3339),
	}
	if r := msg.GetBody(section); r != nil {
		out.BodyText, out.BodyHTML = extractBody(r)
	}
	return out, nil
}

// Send submits a plain-text message over SMTP (STARTTLS handled by SendMail).
func (s *Service) Send(user, pass, from, to, subject, body string) error {
	var auth smtp.Auth
	if pass != "" {
		auth = smtp.PlainAuth("", user, pass, hostOnly(s.cfg.SMTPAddr))
	}
	return smtp.SendMail(s.cfg.SMTPAddr, auth, from, []string{to}, []byte(buildMessage(from, to, subject, body)))
}

// --- helpers ---

func hostOnly(addr string) string {
	if i := strings.LastIndex(addr, ":"); i >= 0 {
		return addr[:i]
	}
	return addr
}

func hasFlag(flags []string, want string) bool {
	for _, f := range flags {
		if f == want {
			return true
		}
	}
	return false
}

func fromString(env *imap.Envelope) string {
	if env == nil || len(env.From) == 0 {
		return ""
	}
	a := env.From[0]
	if a.PersonalName != "" {
		return a.PersonalName
	}
	return a.MailboxName + "@" + a.HostName
}

func extractBody(r io.Reader) (text, html string) {
	raw, _ := io.ReadAll(r)
	mr, err := gomail.CreateReader(bytes.NewReader(raw))
	if err != nil {
		return string(raw), "" // not MIME multipart — treat as plain text
	}
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		} else if err != nil {
			break
		}
		if h, ok := part.Header.(*gomail.InlineHeader); ok {
			ct, _, _ := h.ContentType()
			b, _ := io.ReadAll(part.Body)
			switch {
			case strings.HasPrefix(ct, "text/html"):
				html = string(b)
			case strings.HasPrefix(ct, "text/plain"):
				text = string(b)
			}
		}
	}
	return text, html
}

func buildMessage(from, to, subject, body string) string {
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", subject) + "\r\n")
	b.WriteString("Date: " + time.Now().UTC().Format(time.RFC1123Z) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n\r\n")
	b.WriteString(body)
	return b.String()
}
