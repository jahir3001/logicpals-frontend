# LogicPals Data Retention Policy

**Version:** 1.0  
**Effective Date:** March 2026  
**Owner:** Jahir (CTO, LogicPals)  
**Classification:** Internal — Confidential  
**Next Review:** September 2026

---

## 1. Purpose

This document defines the data retention schedule for every table in the LogicPals production database. It establishes how long data is kept, how it is deleted, what can be exported by parents, and which tables are permanently immutable for compliance.

This policy is a **Phase 0 gate requirement**. Automated enforcement (scheduled deletion jobs) will be implemented in Phase 2.

---

## 2. Guiding Principles

- **Student data is the most sensitive.** Attempts, sessions, and scoring data belong to the child and their parent. Retention is limited to what is operationally necessary.
- **Audit data is permanent.** `audit_log` and `admin_audit_events` are never deleted. They are the compliance backbone of the platform.
- **AI cost data is financial data.** `ai_cost_ledger` is append-only and retained for 1 year for cost auditing.
- **Parents have export rights.** Any data directly tied to a child's learning activity can be requested for export by the parent at any time.
- **Soft delete before hard delete.** User-facing data uses a `deleted_at` timestamp before permanent removal, giving a 30-day recovery window.

---

## 3. Retention Schedule by Table

### 3.1 Core Student Activity

| Table | Retention | Deletion Type | Parent Export | Notes |
|-------|-----------|---------------|---------------|-------|
| `attempts` | 2 years from submission | Soft delete (`deleted_at`), then hard delete after 30-day recovery window | Yes | Most important student data. Drives mastery and scoring. |
| `session_items` | 2 years | Cascade-deleted with parent session | Yes | Items within a session. |
| `sessions` | 1 year active + 6 months archived | Soft delete | Yes | Locked sessions (`locked_at`) retained until parent of session retention expires. |
| `scoring_events` | 2 years | Hard delete after retention period | Yes | Score history. Required for dispute resolution. |
| `session_attempts` | 2 years | Cascade-deleted with attempts | Yes | |
| `hint_events` | 1 year | Hard delete | Yes | Hint usage per attempt. |
| `attempt_events` | 1 year | Hard delete | No | Low-level interaction events. Not exported. |

### 3.2 AI & Cost Data

| Table | Retention | Deletion Type | Parent Export | Notes |
|-------|-----------|---------------|---------------|-------|
| `ai_cost_ledger` | 1 year | Hard delete after 1 year | No | Financial/operational data. Append-only. |
| `ai_interactions` | N/A — placeholder table | N/A | No | 0 rows. Superseded by `ai_cost_ledger`. Will be dropped in Phase 2. |
| `ai_model_pricing` | Permanent | Never deleted | No | Configuration table. |

### 3.3 Session Infrastructure

| Table | Retention | Deletion Type | Parent Export | Notes |
|-------|-----------|---------------|---------------|-------|
| `session_composer_audit` | 90 days | Hard delete | No | Composer debug logs. Short retention — high volume expected. |
| `session_audit_log` | 1 year | Hard delete | No | Session-level events. |
| `session_idempotency` | 30 days | Hard delete | No | Idempotency keys expire naturally. |
| `tutor_sessions` | 1 year | Soft delete | Yes | Voice tutor session records. |
| `coaching_sessions` | 1 year | Soft delete | Yes | |

### 3.4 Olympiad Track

| Table | Retention | Deletion Type | Parent Export | Notes |
|-------|-----------|---------------|---------------|-------|
| `olympiad_progress` | Until account deletion | Deleted with account | Yes | Long-term competition progress. |
| `olympiad_generation_jobs` | 6 months after job completion | Hard delete | No | AI generation jobs. Operational data. |
| `olympiad_generation_attempts` | 6 months | Hard delete | No | |
| `olympiad_gate_evaluations` | 1 year | Hard delete | No | Gate scoring records. |
| `olympiad_gate_events` | 1 year | Hard delete | No | |
| `olympiad_gate_scoring_queue` | 30 days post-processing | Hard delete | No | Queue entries cleared after scoring. |
| `mock_tests` | Until account deletion | Deleted with account | Yes | Student mock test records. |

### 3.5 Mastery & Learning Progress

| Table | Retention | Deletion Type | Parent Export | Notes |
|-------|-----------|---------------|---------------|-------|
| `skill_mastery` | Until account deletion | Deleted with account | Yes | Core learning record. Never expires while account active. |
| `mastery_jobs` | 90 days post-completion | Hard delete | No | Background mastery computation jobs. |
| `mastery_unit_state` | Until account deletion | Deleted with account | Yes | Per-unit mastery state. |
| `mastery_unit_metrics` | 1 year | Hard delete | No | Aggregate metrics. Regenerable. |
| `readiness` | Until account deletion | Deleted with account | Yes | Readiness scores. |

### 3.6 Explainability & Disputes

| Table | Retention | Deletion Type | Parent Export | Notes |
|-------|-----------|---------------|---------------|-------|
| `lp_explainability_events` | 2 years | **Immutable** (append-only) — no deletion | Yes | AI decision audit trail. Required for dispute evidence. |
| `lp_hint_events` | 2 years | **Immutable** (append-only) — no deletion | Yes | Hint policy audit trail. |
| `lp_score_receipts` | 2 years | **Immutable** (append-only) — no deletion | Yes | Score tamper-proof receipts. |
| `lp_disputes` | 3 years | Soft close (`status = resolved`) | Yes | Dispute records. Compliance requirement. |
| `lp_dispute_audit` | 3 years | Never deleted | Admin only | Full audit of every dispute action. |
| `lp_policy_versions` | Permanent | **Immutable** — never deleted | No | Prompt policy version history. |

### 3.7 A/B Experiments

| Table | Retention | Deletion Type | Parent Export | Notes |
|-------|-----------|---------------|---------------|-------|
| `ab_experiments` | 1 year post-completion | Hard delete | No | |
| `ab_variants` | 1 year post-completion | Cascade with experiment | No | |
| `ab_exposures` | 1 year | Hard delete | No | |
| `ab_assignments` | 1 year | Hard delete | No | |
| `ab_attributions` | 1 year | Hard delete | No | |
| `ab_metric_events` | 1 year | Hard delete | No | |
| `ab_metrics` | 1 year | Hard delete | No | |
| `ab_metrics_daily` | 1 year | Hard delete | No | |
| `ab_rollup_runs` | 6 months | Hard delete | No | |
| `ab_session_variants` | 1 year | Hard delete | No | |
| `ab_dashboard_refresh_runs` | 30 days | Hard delete | No | |
| `ab_experiment_allowlist` | Deleted with experiment | Cascade | No | |

### 3.8 User & Account Data

| Table | Retention | Deletion Type | Parent Export | Notes |
|-------|-----------|---------------|---------------|-------|
| `profiles` | Until account deletion request | Full purge on verified request | Yes (self) | GDPR-equivalent right to erasure. |
| `children` | Until parent account deletion | Full purge with parent | Yes | Linked to parent profile. |
| `subscriptions` | 7 years | Soft delete (financial record) | Yes | Financial compliance. Bangladesh VAT records. |
| `user_roles` | Deleted with profile | Cascade | No | |
| `lp_parent_links` | Deleted with account | Cascade | No | |
| `schools` | Permanent while active | Admin-managed | No | Institutional data. |

### 3.9 Audit & Compliance (Never Deleted)

| Table | Retention | Deletion Type | Notes |
|-------|-----------|---------------|-------|
| `audit_log` | **Permanent** | **Never deleted** | Immutable via trigger. Core compliance log. |
| `admin_audit_events` | **Permanent** | **Never deleted** | All admin actions permanently recorded. |
| `alert_log` | **Permanent** | **Never deleted** | P0.5 alert history. Immutable. |

### 3.10 Platform Operations

| Table | Retention | Deletion Type | Notes |
|-------|-----------|---------------|-------|
| `rate_limits` | 24 hours (rolling window) | Auto-expired by application logic | |
| `api_rate_limits` | 24 hours (rolling window) | Auto-expired | |
| `alert_budgets` | Permanent | Admin-managed | Configuration table. |
| `api_version_registry` | Permanent | Admin-managed | API contract table. |
| `tier_features` | Permanent | Admin-managed | Feature flag configuration. |
| `regular_archetypes` | Permanent | Admin-managed | Problem archetype definitions. |
| `olympiad_archetypes` | Permanent | Admin-managed | |
| `olympiad_archetype_mappings` | Permanent | Admin-managed | |
| `skills` | Permanent | Admin-managed | |
| `problem_skills` | Permanent | Admin-managed | |
| `problems` | Permanent (soft-deactivated) | `is_active = false`, never hard-deleted | Problem bank is permanent. |

---

## 4. Vision / Image Data (Phase 4 — Future)

When Vision Guidance (P4) is implemented, student-uploaded images of handwritten work will follow this policy:

| Data | Retention | Notes |
|------|-----------|-------|
| Uploaded images (Supabase Storage) | **30 days post-session** | Hard delete from storage bucket. No long-term image retention. |
| Image metadata in DB | 30 days | Deleted with image. |
| AI analysis results | 1 year | Retained as part of `ai_cost_ledger` and explainability events. |

---

## 5. Parent Data Export

Parents can request a full export of their child's learning data at any time. The export includes:

- All attempts and scores
- Session history
- Mastery state and progress
- Hint usage history
- Explainability events (AI decisions)
- Score receipts
- Mock test results
- Olympiad progress

**Export format:** JSON (structured) or CSV (tabular).  
**Delivery SLA:** Within 7 days of verified request.  
**Exclusions:** Internal AI cost data, A/B experiment data, platform operational logs.

---

## 6. Account Deletion

When a parent requests account deletion:

1. All children linked to the account are soft-deleted immediately (access revoked).
2. A 30-day recovery window begins. Account can be restored within this window.
3. After 30 days: hard delete of all student activity data, profiles, children records, mastery data, and session history.
4. **Retained after deletion:** `subscriptions` (7 years, financial compliance), `audit_log` entries (permanent, anonymised), `scoring_events` if part of an open dispute.
5. Parent receives confirmation email with deletion receipt.

---

## 7. Enforcement Implementation Plan

| Phase | Action | Target Date |
|-------|--------|-------------|
| Phase 0 (now) | Policy documented and committed to repo | March 2026 |
| Phase 2 | Automated deletion jobs via pg_cron | TBD |
| Phase 2 | `deleted_at` soft-delete columns added where missing | TBD |
| Phase 2 | Parent export endpoint (`/v1/rpc/export_child_data`) | TBD |
| Phase 4 | Vision image auto-deletion after 30 days | TBD |

---

## 8. Immutable Tables (Append-Only)

The following tables use `lp_block_update_delete()` triggers and **cannot be modified or deleted** by any database role including `service_role`:

- `audit_log`
- `admin_audit_events`
- `ai_cost_ledger`
- `alert_log`
- `lp_explainability_events`
- `lp_hint_events`
- `lp_score_receipts`
- `lp_policy_versions`

Any attempt to UPDATE or DELETE rows in these tables will raise an exception and be blocked at the database level.

---

## 9. Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | March 2026 | Jahir (CTO) | Initial policy — Phase 0 gate requirement |
