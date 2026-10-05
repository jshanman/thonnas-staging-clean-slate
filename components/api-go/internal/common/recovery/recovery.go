package recovery

import (
	"runtime/debug"
	
	"thonnas/api-go/internal/common/logger"
)

// RecoverGoroutine recovers from panics in goroutines and logs them
// This prevents a single goroutine panic from crashing the entire service
// Usage: defer recovery.RecoverGoroutine(log, "goroutineName")
func RecoverGoroutine(log *logger.Logger, goroutineName string) {
	if r := recover(); r != nil {
		// Capture stack trace
		stack := debug.Stack()
		
		// Log panic with full context
		log.WithFields(map[string]interface{}{
			"panic":       r,
			"goroutine":   goroutineName,
			"stack_trace": string(stack),
		}).Error("Goroutine panic recovered")
	}
}

// RecoverGoroutineWithCallback recovers from panics and executes a callback
// Useful when you need cleanup after panic (e.g., close connections)
func RecoverGoroutineWithCallback(log *logger.Logger, goroutineName string, callback func()) {
	if r := recover(); r != nil {
		// Capture stack trace
		stack := debug.Stack()
		
		// Log panic with full context
		log.WithFields(map[string]interface{}{
			"panic":       r,
			"goroutine":   goroutineName,
			"stack_trace": string(stack),
		}).Error("Goroutine panic recovered")
		
		// Execute cleanup callback
		if callback != nil {
			// Wrap callback in another recover to prevent callback panics
			defer func() {
				if r2 := recover(); r2 != nil {
					log.WithFields(map[string]interface{}{
						"panic":     r2,
						"goroutine": goroutineName + "_cleanup",
					}).Error("Panic in cleanup callback")
				}
			}()
			
			callback()
		}
	}
}




