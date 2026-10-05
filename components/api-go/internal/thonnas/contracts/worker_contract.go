package contracts

import (
	"context"
	"time"
)

// ThonnasJobInput is opaque job payload data (JSON-serializable in adapters).
type ThonnasJobInput interface{}

// ThonnasJobResult is opaque job output data.
type ThonnasJobResult interface{}

// ThonnasJobSchedule defines portable cron-style scheduling without vendor SDK types.
type ThonnasJobSchedule struct {
	CronExpression string
	Timezone       string
	Enabled        bool
	MaxRetries     int
	Timeout        time.Duration
}

// ThonnasJob is a schedulable unit registered by installed feature packages.
type ThonnasJob interface {
	GetID() string
	GetName() string
	GetDescription() string
	GetScheduleConfig() *ThonnasJobSchedule
	DefaultInput() ThonnasJobInput
	Execute(ctx context.Context, input ThonnasJobInput) (ThonnasJobResult, error)
}

// ThonnasWorker collects jobs from feature packages; worker backends drain ListJobs at startup.
type ThonnasWorker interface {
	RegisterJob(job ThonnasJob) error
	ListJobs() ([]ThonnasJob, error)
}

