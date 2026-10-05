package errors

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestAppError_Error(t *testing.T) {
	t.Run("with wrapped error", func(t *testing.T) {
		innerErr := errors.New("inner error")
		appErr := &AppError{
			Code:    "TEST_ERROR",
			Message: "test message",
			Err:     innerErr,
		}

		expected := "[TEST_ERROR] test message: inner error"
		assert.Equal(t, expected, appErr.Error())
	})

	t.Run("without wrapped error", func(t *testing.T) {
		appErr := &AppError{
			Code:    "TEST_ERROR",
			Message: "test message",
		}

		expected := "[TEST_ERROR] test message"
		assert.Equal(t, expected, appErr.Error())
	})
}

func TestAppError_Unwrap(t *testing.T) {
	t.Run("with wrapped error", func(t *testing.T) {
		innerErr := errors.New("inner error")
		appErr := &AppError{
			Code:    "TEST_ERROR",
			Message: "test message",
			Err:     innerErr,
		}

		unwrapped := appErr.Unwrap()
		assert.Equal(t, innerErr, unwrapped)
	})

	t.Run("without wrapped error", func(t *testing.T) {
		appErr := &AppError{
			Code:    "TEST_ERROR",
			Message: "test message",
		}

		unwrapped := appErr.Unwrap()
		assert.Nil(t, unwrapped)
	})
}

func TestAppError_EmptyFields(t *testing.T) {
	err := &AppError{}

	// Test with empty fields
	errorStr := err.Error()
	assert.Equal(t, "[] ", errorStr)

	unwrapped := err.Unwrap()
	assert.Nil(t, unwrapped)
}

func TestAppError_ErrorInterface(t *testing.T) {
	// Verify AppError implements error interface
	appErr := &AppError{
		Code:    "TEST_ERROR",
		Message: "test message",
	}
	var err error = appErr

	assert.NotNil(t, err)
	assert.Contains(t, err.Error(), "TEST_ERROR")
}

func TestAppError_Unwrapping(t *testing.T) {
	// Test error unwrapping with errors.Is and errors.As
	innerErr := errors.New("original error")
	appErr := &AppError{
		Code:    "WRAPPER",
		Message: "wrapper message",
		Err:     innerErr,
	}

	// Test Unwrap returns the inner error
	unwrapped := errors.Unwrap(appErr)
	assert.Equal(t, innerErr, unwrapped)

	// Test errors.Is works with wrapped errors
	assert.True(t, errors.Is(appErr, innerErr))
}

func TestAppError_AsError(t *testing.T) {
	// Test that AppError can be used as a regular error
	testErr := &AppError{
		Code:    "TEST_ERROR",
		Message: "test message",
	}
	var err error = testErr

	assert.NotNil(t, err)
	assert.Error(t, err)

	// Test errors.As
	var appErr *AppError
	assert.True(t, errors.As(err, &appErr))
	assert.Equal(t, "TEST_ERROR", appErr.Code)
}

