package tmmqtt

// MQTT Topic Constants
// Centralized topic definitions to prevent typos, enable easy refactoring,
// and provide self-documenting code.

const (
	// User Count Topics
	TopicUserCount = "users/count"

	// Status Topics
	// Pattern: status/{type}/{component}/{clientId}
	// Examples:
	//   - status/user/web/user-web-123
	//   - status/user/mobile/user-mobile-456
	TopicStatusUserWeb    = "status/user/web"
	TopicStatusUserMobile = "status/user/mobile"
	TopicStatusUserPattern = "status/user/+/+" // For shared subscriptions: $share/{group}/status/user/+/+

	// Job Runner Topics (for future use)
	TopicJobRunnerStatus = "job-runner/status"
	TopicJobRunnerHealth = "job-runner/health"
	TopicJobRunnerErrors = "job-runner/errors"

	// Notification Topics (for future use)
	TopicNotificationsNew      = "notifications/new"
	TopicNotificationsUser     = "notifications/user"      // Pattern: notifications/user/{userId}
	TopicNotificationsUserPattern = "notifications/user/+" // For user-specific notifications

	// Presence Topics (for future use)
	TopicPresenceUser     = "presence/user"     // Pattern: presence/user/{userId}
	TopicPresenceUserPattern = "presence/user/+" // For user presence updates
)

// BuildStatusTopic constructs a status topic for a specific client
// Format: status/{type}/{component}/{clientId}
func BuildStatusTopic(clientType, component, clientId string) string {
	return "status/" + clientType + "/" + component + "/" + clientId
}

// BuildNotificationTopic constructs a notification topic for a specific user
// Format: notifications/user/{userId}
func BuildNotificationTopic(userId string) string {
	return "notifications/user/" + userId
}

// BuildPresenceTopic constructs a presence topic for a specific user
// Format: presence/user/{userId}
func BuildPresenceTopic(userId string) string {
	return "presence/user/" + userId
}


