package store

import (
	"fmt"
	"sync"
	"time"
)

// Memory is the in-memory Store used for the MVP. It is safe for concurrent use.
// Swapping in Postgres means implementing the same Store interface — nothing in
// the API layer changes.
type Memory struct {
	mu       sync.RWMutex
	clients  map[string]Client
	products map[string]Product
	services map[string]Service
	invoices map[string]Invoice
	invSeq   int
	now      func() time.Time
}

func NewMemory() *Memory {
	return &Memory{
		clients:  map[string]Client{},
		products: map[string]Product{},
		services: map[string]Service{},
		invoices: map[string]Invoice{},
		now:      time.Now,
	}
}

func (m *Memory) CreateProduct(name, planCode string, priceCents int, cycle string) (Product, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cycle == "" {
		cycle = "monthly"
	}
	p := Product{ID: NewID("prod"), Name: name, PlanCode: planCode, PriceCents: priceCents, Cycle: cycle, CreatedAt: m.now().UTC()}
	m.products[p.ID] = p
	return p, nil
}

func (m *Memory) ListProducts() []Product {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Product, 0, len(m.products))
	for _, p := range m.products {
		out = append(out, p)
	}
	return out
}

func (m *Memory) GetProduct(id string) (Product, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.products[id]
	if !ok {
		return Product{}, ErrNotFound
	}
	return p, nil
}

func (m *Memory) DeleteProduct(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.products[id]; !ok {
		return ErrNotFound
	}
	delete(m.products, id)
	return nil
}

func (m *Memory) CreateClient(name, email string) (Client, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := Client{ID: NewID("cli"), Name: name, Email: email, Status: "active", CreatedAt: m.now().UTC()}
	m.clients[c.ID] = c
	return c, nil
}

func (m *Memory) ListClients() []Client {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Client, 0, len(m.clients))
	for _, c := range m.clients {
		out = append(out, c)
	}
	return out
}

func (m *Memory) GetClient(id string) (Client, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	c, ok := m.clients[id]
	if !ok {
		return Client{}, ErrNotFound
	}
	return c, nil
}

func (m *Memory) CreateService(s Service) (Service, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s.ID == "" {
		s.ID = NewID("svc")
	}
	if s.CreatedAt.IsZero() {
		s.CreatedAt = m.now().UTC()
	}
	m.services[s.ID] = s
	return s, nil
}

func (m *Memory) ListServices() []Service {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Service, 0, len(m.services))
	for _, s := range m.services {
		out = append(out, s)
	}
	return out
}

func (m *Memory) GetService(id string) (Service, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.services[id]
	if !ok {
		return Service{}, ErrNotFound
	}
	return s, nil
}

func (m *Memory) SetServiceStatus(id, status string) (Service, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.services[id]
	if !ok {
		return Service{}, ErrNotFound
	}
	s.Status = status
	m.services[id] = s
	return s, nil
}

func (m *Memory) CreateInvoice(clientID string, lines []InvoiceLine, dueDays int) (Invoice, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	total := 0
	for _, l := range lines {
		total += l.AmountCents
	}
	m.invSeq++
	now := m.now().UTC()
	inv := Invoice{
		ID:         NewID("inv"),
		ClientID:   clientID,
		Number:     fmt.Sprintf("INV-%d-%04d", now.Year(), m.invSeq),
		Status:     "open",
		TotalCents: total,
		Lines:      lines,
		IssuedAt:   now,
		DueAt:      now.AddDate(0, 0, dueDays),
	}
	m.invoices[inv.ID] = inv
	return inv, nil
}

func (m *Memory) ListInvoices() []Invoice {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Invoice, 0, len(m.invoices))
	for _, i := range m.invoices {
		out = append(out, i)
	}
	return out
}

func (m *Memory) GetInvoice(id string) (Invoice, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	i, ok := m.invoices[id]
	if !ok {
		return Invoice{}, ErrNotFound
	}
	return i, nil
}

func (m *Memory) SetInvoiceStatus(id, status string) (Invoice, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	i, ok := m.invoices[id]
	if !ok {
		return Invoice{}, ErrNotFound
	}
	i.Status = status
	if status == "paid" {
		t := m.now().UTC()
		i.PaidAt = &t
	}
	m.invoices[id] = i
	return i, nil
}
