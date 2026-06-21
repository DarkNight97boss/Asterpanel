package store

import (
	"sync"
	"time"
)

// Memory is the in-memory Store used for the MVP. It is safe for concurrent use.
// Swapping in Postgres means implementing the same Store interface — nothing in
// the API layer changes.
type Memory struct {
	mu       sync.RWMutex
	clients  map[string]Client
	services map[string]Service
	now      func() time.Time
}

func NewMemory() *Memory {
	return &Memory{
		clients:  map[string]Client{},
		services: map[string]Service{},
		now:      time.Now,
	}
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
