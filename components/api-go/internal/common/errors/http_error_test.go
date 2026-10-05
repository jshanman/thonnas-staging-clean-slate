package errors

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewHTTPError(t *testing.T) {
	err := NewHTTPError(400, "bad_request", "Invalid input")

	assert.Equal(t, 400, err.Status)
	assert.Equal(t, "bad_request", err.Error)
	assert.Equal(t, "Invalid input", err.Message)
	assert.NotEmpty(t, err.Timestamp)
	assert.Empty(t, err.CorrelationID)
	assert.Nil(t, err.Details)

	// Verify timestamp is valid RFC3339
	_, parseErr := time.Parse(time.RFC3339, err.Timestamp)
	assert.NoError(t, parseErr, "Timestamp should be valid RFC3339")
}

func TestHTTPError_WithCorrelationID(t *testing.T) {
	err := NewHTTPError(400, "bad_request", "Invalid input").
		WithCorrelationID("abc-123-def-456")

	assert.Equal(t, "abc-123-def-456", err.CorrelationID)
}

func TestHTTPError_WithDetails(t *testing.T) {
	details := map[string]string{
		"field": "email",
		"issue": "invalid format",
	}

	err := NewHTTPError(400, "bad_request", "Invalid input").
		WithDetails(details)

	assert.Equal(t, details, err.Details)
}

func TestHTTPError_Chaining(t *testing.T) {
	// Test method chaining
	err := NewHTTPError(400, "bad_request", "Invalid input").
		WithCorrelationID("abc-123").
		WithDetails(map[string]string{"field": "email"})

	assert.Equal(t, "abc-123", err.CorrelationID)
	assert.NotNil(t, err.Details)
}

func TestHTTPError_Send(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// Create test context
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	// Create and send error
	err := NewHTTPError(400, "bad_request", "Invalid input").
		WithCorrelationID("test-123")
	err.Send(c)

	// Verify response
	assert.Equal(t, 400, w.Code)

	var response HTTPError
	parseErr := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, parseErr)

	assert.Equal(t, 400, response.Status)
	assert.Equal(t, "bad_request", response.Error)
	assert.Equal(t, "Invalid input", response.Message)
	assert.Equal(t, "test-123", response.CorrelationID)
	assert.NotEmpty(t, response.Timestamp)
}

func TestBadRequest(t *testing.T) {
	err := BadRequest("invalid input")

	assert.Equal(t, 400, err.Status)
	assert.Equal(t, "bad_request", err.Error)
	assert.Equal(t, "invalid input", err.Message)
}

func TestUnauthorized(t *testing.T) {
	err := Unauthorized("authentication required")

	assert.Equal(t, 401, err.Status)
	assert.Equal(t, "unauthorized", err.Error)
	assert.Equal(t, "authentication required", err.Message)
}

func TestForbidden(t *testing.T) {
	err := Forbidden("access denied")

	assert.Equal(t, 403, err.Status)
	assert.Equal(t, "forbidden", err.Error)
	assert.Equal(t, "access denied", err.Message)
}

func TestNotFound(t *testing.T) {
	err := NotFound("resource not found")

	assert.Equal(t, 404, err.Status)
	assert.Equal(t, "not_found", err.Error)
	assert.Equal(t, "resource not found", err.Message)
}

func TestInternalServerError(t *testing.T) {
	err := InternalServerError("internal error")

	assert.Equal(t, 500, err.Status)
	assert.Equal(t, "internal_server_error", err.Error)
	assert.Equal(t, "internal error", err.Message)
}

func TestSendError_WithCorrelationID(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// Create test context with correlation ID
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set("correlationId", "test-correlation-123")

	// Send error
	SendError(c, 400, "bad_request", "Invalid input")

	// Verify response
	assert.Equal(t, 400, w.Code)

	var response HTTPError
	parseErr := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, parseErr)

	assert.Equal(t, 400, response.Status)
	assert.Equal(t, "bad_request", response.Error)
	assert.Equal(t, "Invalid input", response.Message)
	assert.Equal(t, "test-correlation-123", response.CorrelationID)
}

func TestSendError_WithoutCorrelationID(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// Create test context without correlation ID
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	// Send error
	SendError(c, 404, "not_found", "Resource not found")

	// Verify response
	assert.Equal(t, 404, w.Code)

	var response HTTPError
	parseErr := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, parseErr)

	assert.Equal(t, 404, response.Status)
	assert.Equal(t, "not_found", response.Error)
	assert.Equal(t, "Resource not found", response.Message)
	assert.Empty(t, response.CorrelationID)
}

func TestSendError_WithInvalidCorrelationIDType(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// Create test context with non-string correlation ID
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set("correlationId", 12345) // int instead of string

	// Send error
	SendError(c, 400, "bad_request", "Invalid input")

	// Verify response
	assert.Equal(t, 400, w.Code)

	var response HTTPError
	parseErr := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, parseErr)

	// Correlation ID should be empty since it wasn't a string
	assert.Empty(t, response.CorrelationID)
}

func TestHTTPError_TableDriven(t *testing.T) {
	tests := []struct {
		name           string
		constructor    func(string) *HTTPError
		message        string
		expectedStatus int
		expectedError  string
	}{
		{
			name:           "BadRequest",
			constructor:    BadRequest,
			message:        "invalid input",
			expectedStatus: 400,
			expectedError:  "bad_request",
		},
		{
			name:           "Unauthorized",
			constructor:    Unauthorized,
			message:        "auth required",
			expectedStatus: 401,
			expectedError:  "unauthorized",
		},
		{
			name:           "Forbidden",
			constructor:    Forbidden,
			message:        "access denied",
			expectedStatus: 403,
			expectedError:  "forbidden",
		},
		{
			name:           "NotFound",
			constructor:    NotFound,
			message:        "not found",
			expectedStatus: 404,
			expectedError:  "not_found",
		},
		{
			name:           "InternalServerError",
			constructor:    InternalServerError,
			message:        "internal error",
			expectedStatus: 500,
			expectedError:  "internal_server_error",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.constructor(tt.message)

			assert.Equal(t, tt.expectedStatus, err.Status)
			assert.Equal(t, tt.expectedError, err.Error)
			assert.Equal(t, tt.message, err.Message)
			assert.NotEmpty(t, err.Timestamp)
			assert.Empty(t, err.CorrelationID)
			assert.Nil(t, err.Details)
		})
	}
}

func TestHTTPError_JSONSerialization(t *testing.T) {
	err := NewHTTPError(400, "bad_request", "Invalid input").
		WithCorrelationID("test-123").
		WithDetails(map[string]string{"field": "email"})

	// Serialize to JSON
	data, marshalErr := json.Marshal(err)
	require.NoError(t, marshalErr)

	// Deserialize from JSON
	var deserialized HTTPError
	unmarshalErr := json.Unmarshal(data, &deserialized)
	require.NoError(t, unmarshalErr)

	// Verify fields match
	assert.Equal(t, err.Status, deserialized.Status)
	assert.Equal(t, err.Error, deserialized.Error)
	assert.Equal(t, err.Message, deserialized.Message)
	assert.Equal(t, err.CorrelationID, deserialized.CorrelationID)
	assert.Equal(t, err.Timestamp, deserialized.Timestamp)
	assert.NotNil(t, deserialized.Details)
}

func TestHTTPError_JSONFields(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// Create test context
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	// Create error with all fields
	err := NewHTTPError(400, "bad_request", "Invalid input").
		WithCorrelationID("test-123").
		WithDetails(map[string]string{"field": "email"})
	err.Send(c)

	// Parse JSON response
	var jsonData map[string]interface{}
	parseErr := json.Unmarshal(w.Body.Bytes(), &jsonData)
	require.NoError(t, parseErr)

	// Verify JSON field names match struct tags
	assert.Equal(t, float64(400), jsonData["status"])
	assert.Equal(t, "bad_request", jsonData["error"])
	assert.Equal(t, "Invalid input", jsonData["message"])
	assert.Equal(t, "test-123", jsonData["correlationId"])
	assert.NotNil(t, jsonData["timestamp"])
	assert.NotNil(t, jsonData["details"])
}

func TestHTTPError_OmitEmptyFields(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// Create test context
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	// Create error without optional fields
	err := NewHTTPError(404, "not_found", "Not found")
	err.Send(c)

	// Parse JSON response
	var jsonData map[string]interface{}
	parseErr := json.Unmarshal(w.Body.Bytes(), &jsonData)
	require.NoError(t, parseErr)

	// Verify optional fields are omitted or empty
	_, hasCorrelationID := jsonData["correlationId"]
	_, hasDetails := jsonData["details"]

	// These fields should either not exist or be null/empty due to omitempty
	assert.False(t, hasCorrelationID || jsonData["correlationId"] != nil)
	assert.False(t, hasDetails || jsonData["details"] != nil)
}

func TestHTTPError_ComplexDetails(t *testing.T) {
	details := map[string]interface{}{
		"fields": []string{"email", "password"},
		"count":  2,
		"nested": map[string]string{
			"key": "value",
		},
	}

	err := NewHTTPError(400, "validation_error", "Multiple validation errors").
		WithDetails(details)

	assert.Equal(t, details, err.Details)

	// Verify can be serialized
	data, marshalErr := json.Marshal(err)
	require.NoError(t, marshalErr)
	assert.NotEmpty(t, data)
}

func TestHTTPError_MultipleRequests(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// Test that multiple errors can be sent independently
	for i := 0; i < 5; i++ {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)

		SendError(c, 400, "bad_request", "Test error")

		assert.Equal(t, 400, w.Code)

		var response HTTPError
		parseErr := json.Unmarshal(w.Body.Bytes(), &response)
		require.NoError(t, parseErr)

		assert.Equal(t, "bad_request", response.Error)
	}
}

