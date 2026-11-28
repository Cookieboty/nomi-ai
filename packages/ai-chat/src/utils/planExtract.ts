import type { PlanEntry, PlanEntryPriority, PlanEntryStatus } from '../services/harnessClient';

function firstText(o: Record<string, unknown> | null, keys: readonly string[]): string | undefined {
  if (!o) return undefined;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function parseJsonObject(input: string | undefined): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const v = JSON.parse(input) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function normalizePlanStatus(raw: unknown): PlanEntryStatus {
  if (typeof raw !== 'string') return 'pending';
  switch (raw.trim().toLowerCase()) {
    case 'in_progress':
    case 'inprogress':
    case 'in-progress':
    case 'running':
    case 'active':
      return 'in_progress';
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'skipped':
    case 'cancelled':
    case 'canceled':
      return 'skipped';
    default:
      return 'pending';
  }
}

export function normalizePlanPriority(raw: unknown): PlanEntryPriority | undefined {
  if (typeof raw !== 'string') return undefined;
  const lower = raw.trim().toLowerCase();
  if (lower === 'high' || lower === 'medium' || lower === 'low') return lower;
  return undefined;
}

export function normalizePlanEntries(raw: unknown): PlanEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: PlanEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const content = firstText(rec, ['content', 'title', 'step', 'text', 'subject']);
    if (!content) continue;
    const priority = normalizePlanPriority(rec.priority);
    out.push({
      content,
      status: normalizePlanStatus(rec.status),
      ...(priority ? { priority } : {}),
    });
  }
  return out;
}

/** 从 todo / update_steps / update_plan 工具的输入 JSON 中提取结构化步骤清单 */
export function extractPlanFromTodoTool(call: { input?: string }): PlanEntry[] | null {
  const o = parseJsonObject(call.input);
  if (!o) return null;
  const rawList = Array.isArray(o.steps)
    ? o.steps
    : Array.isArray(o.plan)
      ? o.plan
      : Array.isArray(o.todos)
        ? o.todos
        : Array.isArray(o.entries)
          ? o.entries
          : null;
  if (!rawList) return null;
  const entries = normalizePlanEntries(rawList);
  return entries.length > 0 ? entries : null;
}
