// Package canonical produces a deterministic JSON encoding (RFC 8785-style:
// lexicographically sorted object keys, minimal whitespace). The control plane
// signs these canonical bytes and transmits them verbatim; the agent verifies
// the signature over the exact bytes it receives, so the two languages never
// need to agree on a re-serialization.
package canonical

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
)

// Marshal returns the canonical JSON encoding of v.
func Marshal(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber() // preserve numeric literals exactly
	var intf any
	if err := dec.Decode(&intf); err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := write(&buf, intf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func write(buf *bytes.Buffer, v any) error {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			kb, _ := json.Marshal(k)
			buf.Write(kb)
			buf.WriteByte(':')
			if err := write(buf, t[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case []any:
		buf.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := write(buf, e); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case string:
		sb, _ := json.Marshal(t)
		buf.Write(sb)
	case json.Number:
		buf.WriteString(t.String())
	case bool:
		if t {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case nil:
		buf.WriteString("null")
	default:
		return fmt.Errorf("canonical: unsupported type %T", v)
	}
	return nil
}
