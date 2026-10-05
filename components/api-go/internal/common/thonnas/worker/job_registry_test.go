package thonnasworker

import (
	"context"
	"testing"

	"thonnas/api-go/internal/thonnas/contracts"
)

type stubJob struct {
	id string
}

func (s stubJob) GetID() string                          { return s.id }
func (s stubJob) GetName() string                        { return s.id }
func (s stubJob) GetDescription() string                 { return s.id }
func (s stubJob) GetScheduleConfig() *contracts.ThonnasJobSchedule { return &contracts.ThonnasJobSchedule{Enabled: true} }
func (s stubJob) DefaultInput() contracts.ThonnasJobInput        { return nil }
func (s stubJob) Execute(_ context.Context, _ contracts.ThonnasJobInput) (contracts.ThonnasJobResult, error) {
	return nil, nil
}

func TestJobRegistry_RegisterAndList(t *testing.T) {
	reg := NewJobRegistry()
	if err := reg.RegisterJob(stubJob{id: "user-count"}); err != nil {
		t.Fatalf("RegisterJob: %v", err)
	}
	jobs, err := reg.ListJobs()
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 1 || jobs[0].GetID() != "user-count" {
		t.Fatalf("unexpected jobs: %#v", jobs)
	}
}

