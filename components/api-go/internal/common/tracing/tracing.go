package tracing

import (
	"context"
	"fmt"
	"time"
	
	"thonnas/api-go/internal/common/logger"
	
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
)

// TracingConfig holds tracing configuration
type TracingConfig struct {
	Enabled     bool
	ServiceName string
	Environment string
	OTelEndpoint string
}

// InitTracing initializes OpenTelemetry tracing
// Returns a shutdown function that should be called on application exit
func InitTracing(cfg *TracingConfig, log *logger.Logger) (func(context.Context) error, error) {
	if !cfg.Enabled {
		log.Info("Tracing disabled")
		return func(ctx context.Context) error { return nil }, nil
	}
	
	ctx := context.Background()
	
	// Create resource with service information
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.DeploymentEnvironment(cfg.Environment),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create resource: %w", err)
	}
	
	// Create OTLP trace exporter (exports to SigNoz)
	traceExporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(cfg.OTelEndpoint),
		otlptracegrpc.WithInsecure(),  // Use TLS in production
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create trace exporter: %w", err)
	}
	
	// Create trace provider
	traceProvider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter),
		sdktrace.WithResource(res),
		// Sample all traces in development, adjust for production
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
	)
	
	// Set global trace provider
	otel.SetTracerProvider(traceProvider)
	
	// Set global propagator (for distributed tracing across services)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},  // W3C Trace Context
		propagation.Baggage{},       // W3C Baggage
	))
	
	log.WithFields(map[string]interface{}{
		"endpoint":    cfg.OTelEndpoint,
		"service":     cfg.ServiceName,
		"environment": cfg.Environment,
	}).Info("OpenTelemetry tracing initialized")
	
	// Return shutdown function
	return func(ctx context.Context) error {
		shutdownCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		
		if err := traceProvider.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("failed to shutdown trace provider: %w", err)
		}
		return nil
	}, nil
}




