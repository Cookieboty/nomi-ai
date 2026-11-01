// Package tasks 移植 apps/desktop-electron/internal/core/src/tasks：持续任务的数据模型、错误码与状态机
// （docs/design/persistent-tasks.md）。JSON 形状与 Node 版一致：可选字段用指针 + omitempty，
// 对应 TS 里值为 undefined 的键被去掉；空数组照常输出 []。
package tasks

import (
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/schedule"
)

const SchemaVersion = 1

// 任务状态（types.ts TaskStatus）
const (
	StatusIdle           = "idle"
	StatusQueued         = "queued"
	StatusRunning        = "running"
	StatusWaitingUser    = "waiting_user"
	StatusNeedsReconcile = "needs_reconcile"
	StatusAwaitingAccept = "awaiting_accept"
	StatusDone           = "done"
	StatusFailed         = "failed"
	StatusCancelled      = "cancelled"
	StatusExpired        = "expired"
)

// TerminalStatuses：结束态，不再触发、不再接受执行回报
var TerminalStatuses = []string{StatusDone, StatusFailed, StatusCancelled, StatusExpired}

// InboxStatuses：需要用户处理、出现在收件箱里的状态（§11）
var InboxStatuses = []string{
	StatusWaitingUser, StatusNeedsReconcile, StatusAwaitingAccept, StatusFailed, StatusExpired,
}

// Trigger 对应 types.ts 的判别联合：manual | schedule{at,repeat?,catchUpMs?} | event{sourceId,filter,cooldownMs?,mode}
type Trigger struct {
	Kind       string           `json:"kind"`
	At         *int64           `json:"at,omitempty"`
	Repeat     *schedule.Repeat `json:"repeat,omitempty"`
	CatchUpMs  *int64           `json:"catchUpMs,omitempty"`
	SourceID   *string          `json:"sourceId,omitempty"`
	Filter     json.RawMessage  `json:"filter,omitempty"`
	CooldownMs *int64           `json:"cooldownMs,omitempty"`
	Mode       *string          `json:"mode,omitempty"`
}

// ExecutorSpec 对应 notify{text} | nomi{model?,tools} | cli{cli,model?,cwd,isolation}
type ExecutorSpec struct {
	Kind      string    `json:"kind"`
	Text      *string   `json:"text,omitempty"`
	Model     *string   `json:"model,omitempty"`
	Tools     *[]string `json:"tools,omitempty"`
	Scenario  *string   `json:"scenario,omitempty"`
	Cli       *string   `json:"cli,omitempty"`
	Cwd       *string   `json:"cwd,omitempty"`
	Isolation *string   `json:"isolation,omitempty"`
}

type ConnectionGrant struct {
	ConnectionID string   `json:"connectionId"`
	Capabilities []string `json:"capabilities"`
	Resources    []string `json:"resources"`
}

type Grant struct {
	Version     int               `json:"version"`
	Level       int               `json:"level"`
	Paths       []string          `json:"paths"`
	Connections []ConnectionGrant `json:"connections"`
	Clis        *[]string         `json:"clis,omitempty"`
	GrantedAt   int64             `json:"grantedAt"`
	ExpiresAt   *int64            `json:"expiresAt,omitempty"`
	RevokedAt   *int64            `json:"revokedAt,omitempty"`
}

type Budget struct {
	MaxTokensPerAttempt     *int64   `json:"maxTokensPerAttempt,omitempty"`
	MaxDurationMsPerAttempt *int64   `json:"maxDurationMsPerAttempt,omitempty"`
	MaxCostUsdPerDay        *float64 `json:"maxCostUsdPerDay,omitempty"`
	MaxRetries              int      `json:"maxRetries"`
}

// Wait：任务停在 waiting_user 的原因
type Wait struct {
	Kind      string  `json:"kind"`
	RequestID *string `json:"requestId,omitempty"`
	Detail    *string `json:"detail,omitempty"`
	// ResumeTo：running | queued | idle | awaiting_accept
	ResumeTo string `json:"resumeTo"`
}

type ExecutionSnapshot struct {
	GrantVersion int     `json:"grantVersion"`
	ProviderID   *string `json:"providerId,omitempty"`
	Endpoint     *string `json:"endpoint,omitempty"`
	Model        *string `json:"model,omitempty"`
	Cli          *string `json:"cli,omitempty"`
	Cwd          *string `json:"cwd,omitempty"`
	Worktree     *string `json:"worktree,omitempty"`
}

type TaskError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Artifact struct {
	Kind string `json:"kind"`
	Ref  string `json:"ref"`
}

type AttemptResult struct {
	Summary   string     `json:"summary"`
	Artifacts []Artifact `json:"artifacts"`
}

type AttemptCause struct {
	Kind     string  `json:"kind"`
	EventKey *string `json:"eventKey,omitempty"`
	Note     *string `json:"note,omitempty"`
	Answer   *Answer `json:"answer,omitempty"`
}

type Usage struct {
	InputTokens  int64    `json:"inputTokens"`
	OutputTokens int64    `json:"outputTokens"`
	CostUsd      *float64 `json:"costUsd,omitempty"`
	CostKnown    bool     `json:"costKnown"`
}

type Carrier struct {
	TabID     *string `json:"tabId,omitempty"`
	SessionID *string `json:"sessionId,omitempty"`
}

type Attempt struct {
	ID        string            `json:"id"`
	TaskID    string            `json:"taskId"`
	Gen       int               `json:"gen"`
	Cause     AttemptCause      `json:"cause"`
	Snapshot  ExecutionSnapshot `json:"snapshot"`
	Status    string            `json:"status"`
	StartedAt int64             `json:"startedAt"`
	EndedAt   *int64            `json:"endedAt,omitempty"`
	Usage     Usage             `json:"usage"`
	Result    *AttemptResult    `json:"result,omitempty"`
	Error     *TaskError        `json:"error,omitempty"`
	Carrier   *Carrier          `json:"carrier,omitempty"`
}

// Answer：重启后才收到的用户回答，交给续跑的执行
type Answer struct {
	RequestID *string `json:"requestId,omitempty"`
	Approve   bool    `json:"approve"`
	Input     *string `json:"input,omitempty"`
}

type PendingRun struct {
	Cause     string  `json:"cause"`
	EventKey  *string `json:"eventKey,omitempty"`
	Note      *string `json:"note,omitempty"`
	Answer    *Answer `json:"answer,omitempty"`
	NotBefore *int64  `json:"notBefore,omitempty"`
}

type Origin struct {
	ConversationID *string `json:"conversationId,omitempty"`
	CreatedBy      string  `json:"createdBy"`
	CreatedAt      int64   `json:"createdAt"`
}

type Task struct {
	ID                  string       `json:"id"`
	Title               string       `json:"title"`
	Goal                string       `json:"goal"`
	Origin              Origin       `json:"origin"`
	Trigger             Trigger      `json:"trigger"`
	Executor            ExecutorSpec `json:"executor"`
	Grant               Grant        `json:"grant"`
	Budget              Budget       `json:"budget"`
	Acceptance          string       `json:"acceptance"`
	Status              string       `json:"status"`
	Enabled             bool         `json:"enabled"`
	Gen                 int          `json:"gen"`
	RetryCount          int          `json:"retryCount"`
	ConsecutiveFailures int          `json:"consecutiveFailures"`
	Wait                *Wait        `json:"wait,omitempty"`
	Pending             *PendingRun  `json:"pending,omitempty"`
	LastAttemptID       *string      `json:"lastAttemptId,omitempty"`
	NextRunAt           *int64       `json:"nextRunAt,omitempty"`
	LastError           *TaskError   `json:"lastError,omitempty"`
	UpdatedAt           int64        `json:"updatedAt"`
	SchemaVersion       int          `json:"schemaVersion"`
}
