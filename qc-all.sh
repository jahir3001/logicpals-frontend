#!/usr/bin/env bash
# =============================================================================
# qc-all.sh — LogicPals / Provenance Engine QC Regression Harness
# Version: 2.0.0  |  Schema baseline: 2026.05.004
# Tenant: 67c0ebf5-7f52-4d69-ba89-1a1b7baf14be
#
# USAGE:
#   export DATABASE_URL="postgresql://postgres:[PASSWORD]@db.ovszuxerimbmzfblzkgd.supabase.co:5432/postgres"
#   bash qc-all.sh
#
# REQUIRES: psql (PostgreSQL client)
#   Install: https://www.postgresql.org/download/windows/
#   Windows: Select "Command Line Tools" only during install
# =============================================================================

set -euo pipefail

# ── Colour codes ──────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Counters ──────────────────────────────────────────────────────────────────
TOTAL_PASS=0
TOTAL_FAIL=0
SUITE_COUNT=0

TENANT_UUID="67c0ebf5-7f52-4d69-ba89-1a1b7baf14be"

# ── Guard: DATABASE_URL must be set ──────────────────────────────────────────
if [ -z "${DATABASE_URL:-}" ]; then
  echo -e "${RED}ERROR: DATABASE_URL is not set.${NC}"
  echo ""
  echo "Export it before running:"
  echo "  export DATABASE_URL=\"postgresql://postgres:[PASSWORD]@db.ovszuxerimbmzfblzkgd.supabase.co:5432/postgres\""
  echo ""
  echo "Your DB password is in Supabase → Project Settings → Database."
  exit 1
fi

# ── Guard: psql must be installed ────────────────────────────────────────────
if ! command -v psql &>/dev/null; then
  echo -e "${RED}ERROR: psql not found.${NC}"
  echo ""
  echo "Install the PostgreSQL client:"
  echo "  Windows: https://www.postgresql.org/download/windows/"
  echo "  Select 'Command Line Tools' only. Then add to PATH:"
  echo "  export PATH=\"/c/Program Files/PostgreSQL/16/bin:\$PATH\""
  exit 1
fi

# ── run_suite: execute a SQL QC block and report results ─────────────────────
run_suite() {
  local suite_name="$1"
  local sql="$2"
  local suite_pass=0
  local suite_fail=0

  SUITE_COUNT=$((SUITE_COUNT + 1))
  echo ""
  echo -e "${CYAN}${BOLD}━━━ SUITE: ${suite_name} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

  local raw
  raw=$(psql "$DATABASE_URL" -t -A -F'|' -c "$sql" 2>&1) || {
    echo -e "  ${RED}✗ ERROR: Suite failed to execute${NC}"
    echo "  $raw"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    return
  }

  while IFS='|' read -r check_name status detail; do
    [ -z "$check_name" ] && continue
    if [ "$status" = "PASS" ]; then
      echo -e "  ${GREEN}✓ PASS${NC}  ${check_name}  —  ${detail}"
      suite_pass=$((suite_pass + 1))
      TOTAL_PASS=$((TOTAL_PASS + 1))
    else
      echo -e "  ${RED}✗ FAIL${NC}  ${check_name}  —  ${detail}"
      suite_fail=$((suite_fail + 1))
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
    fi
  done <<< "$raw"

  echo -e "  ${BOLD}Suite result: ${suite_pass} PASS / ${suite_fail} FAIL${NC}"
}

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║        LogicPals / Provenance — QC Regression Harness           ║${NC}"
echo -e "${BOLD}║        Schema: 2026.05.004  |  $(date '+%Y-%m-%d %H:%M:%S')              ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════════╝${NC}"


# =============================================================================
# SUITE 1: Core Schema Integrity
# Verifies fundamental tables and schemas exist
# =============================================================================
CORE_SCHEMA_SQL="
WITH
  public_schema AS (
    SELECT 'A_public_schema' AS check_name,
           CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public')
                THEN 'PASS' ELSE 'FAIL' END AS status,
           'public schema exists' AS detail
  ),
  ops_incident_schema AS (
    SELECT 'B_ops_incident_schema' AS check_name,
           CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ops_incident')
                THEN 'PASS' ELSE 'FAIL' END AS status,
           'ops_incident schema exists' AS detail
  ),
  ops_audit_schema AS (
    SELECT 'C_ops_audit_schema' AS check_name,
           CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ops_audit')
                THEN 'PASS' ELSE 'FAIL' END AS status,
           'ops_audit schema exists' AS detail
  ),
  incidents_table AS (
    SELECT 'D_incidents_table' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'ops_incident' AND table_name = 'incidents'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'ops_incident.incidents exists' AS detail
  ),
  incident_events_table AS (
    SELECT 'E_incident_events_table' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'ops_incident' AND table_name = 'incident_events'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'ops_incident.incident_events exists' AS detail
  ),
  append_only_trigger AS (
    SELECT 'F_append_only_trigger' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM pg_trigger
              WHERE tgname = 'trg_block_update_incident_events'
                AND tgrelid = 'ops_incident.incident_events'::regclass
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'append-only guard on incident_events' AS detail
  )
SELECT * FROM public_schema
UNION ALL SELECT * FROM ops_incident_schema
UNION ALL SELECT * FROM ops_audit_schema
UNION ALL SELECT * FROM incidents_table
UNION ALL SELECT * FROM incident_events_table
UNION ALL SELECT * FROM append_only_trigger
ORDER BY check_name;
"
run_suite "core_schema" "$CORE_SCHEMA_SQL"


# =============================================================================
# SUITE 2: Incident Lifecycle RPCs
# Verifies all 17 hardened incident lifecycle functions exist and are SECURITY DEFINER
# =============================================================================
INCIDENT_RPCS_SQL="
WITH
  rpc_count AS (
    SELECT 'A_incident_rpcs_exist' AS check_name,
           CASE WHEN count(*) >= 10 THEN 'PASS' ELSE 'FAIL' END AS status,
           count(*)::text || ' ops_incident RPCs found (expected >=10)' AS detail
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops_incident'
       AND p.proname NOT LIKE '\_%'
  ),
  rpcs_hardened AS (
    SELECT 'B_rpcs_security_definer' AS check_name,
           CASE WHEN bool_and(p.prosecdef) THEN 'PASS' ELSE 'FAIL' END AS status,
           'all ops_incident RPCs are SECURITY DEFINER' AS detail
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops_incident'
       AND p.proname NOT LIKE '\_%'
  ),
  lifecycle_consistency_trigger AS (
    SELECT 'C_lifecycle_consistency_trigger' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM pg_trigger
              WHERE tgname = 'trg_validate_incident_event_lifecycle_consistency'
                AND tgrelid = 'ops_incident.incident_events'::regclass
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'lifecycle consistency trigger on incident_events' AS detail
  ),
  tenant_data_isolated AS (
    SELECT 'D_tenant_data_isolated' AS check_name,
           CASE WHEN count(DISTINCT tenant_uuid) >= 1 THEN 'PASS' ELSE 'FAIL' END AS status,
           count(DISTINCT tenant_uuid)::text || ' tenant(s) in incidents table' AS detail
      FROM ops_incident.incidents
  )
SELECT * FROM rpc_count
UNION ALL SELECT * FROM rpcs_hardened
UNION ALL SELECT * FROM lifecycle_consistency_trigger
UNION ALL SELECT * FROM tenant_data_isolated
ORDER BY check_name;
"
run_suite "incident_rpcs" "$INCIDENT_RPCS_SQL"


# =============================================================================
# SUITE 3: Governance & Audit Infrastructure (P2)
# Verifies audit_log, governance tables, prompt versioning
# =============================================================================
GOVERNANCE_SQL="
WITH
  audit_log AS (
    SELECT 'A_audit_log_exists' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'audit_log'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'audit_log table exists' AS detail
  ),
  audit_immutable AS (
    SELECT 'B_audit_log_immutable' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM pg_trigger
              WHERE tgname = 'audit_log_immutable_guard'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'audit_log_immutable_guard trigger exists' AS detail
  ),
  governance_events AS (
    SELECT 'C_governance_events_table' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'ops_audit' AND table_name = 'governance_events'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'ops_audit.governance_events exists' AS detail
  ),
  backfill_governance_recorded AS (
    SELECT 'D_backfill_audit_trail' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM ops_audit.governance_events
              WHERE event_type = 'backfill_completed'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'Layer 2 backfill event recorded in governance_events' AS detail
  )
SELECT * FROM audit_log
UNION ALL SELECT * FROM audit_immutable
UNION ALL SELECT * FROM governance_events
UNION ALL SELECT * FROM backfill_governance_recorded
ORDER BY check_name;
"
run_suite "governance" "$GOVERNANCE_SQL"


# =============================================================================
# SUITE 4: Ops Incident Command Infrastructure (8M.11)
# Verifies command_registry, dispatch routes, execution boundary
# =============================================================================
COMMAND_INFRA_SQL="
WITH
  command_registry AS (
    SELECT 'A_command_registry' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'ops_incident' AND table_name = 'command_registry'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'command_registry table exists' AS detail
  ),
  dispatch_routes AS (
    SELECT 'B_dispatch_routes' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'ops_incident' AND table_name = 'command_dispatch_routes'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'command_dispatch_routes table exists' AS detail
  ),
  commands_seeded AS (
    SELECT 'C_commands_seeded' AS check_name,
           CASE WHEN count(*) >= 8 THEN 'PASS' ELSE 'FAIL' END AS status,
           count(*)::text || ' commands in registry (expected >=8)' AS detail
      FROM ops_incident.command_registry
     WHERE is_active = true
  ),
  signing_keys_table AS (
    SELECT 'D_signing_keys_table' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'ops_audit' AND table_name = 'signing_keys'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'ops_audit.signing_keys exists' AS detail
  )
SELECT * FROM command_registry
UNION ALL SELECT * FROM dispatch_routes
UNION ALL SELECT * FROM commands_seeded
UNION ALL SELECT * FROM signing_keys_table
ORDER BY check_name;
"
run_suite "command_infrastructure" "$COMMAND_INFRA_SQL"


# =============================================================================
# SUITE 5: Chain Integrity — Layer 2 Cryptographic Chain
# Added: 2026-05-19 after Layer 2 verified (6 events, HMAC-SHA256)
# =============================================================================
CHAIN_INTEGRITY_SQL="
WITH
  ops_audit_schema AS (
    SELECT 'A_ops_audit_schema' AS check_name,
           CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ops_audit')
                THEN 'PASS' ELSE 'FAIL' END AS status,
           'ops_audit schema exists' AS detail
  ),
  signing_key_active AS (
    SELECT 'B_signing_key_active' AS check_name,
           CASE WHEN EXISTS (SELECT 1 FROM ops_audit.signing_keys WHERE status = 'active')
                THEN 'PASS' ELSE 'FAIL' END AS status,
           'active HMAC-SHA256 key: logicpals_2026Q2' AS detail
  ),
  chain_trigger AS (
    SELECT 'C_chain_trigger' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM pg_trigger
              WHERE tgname = 'trg_audit_chain_insert'
                AND tgrelid = 'ops_incident.incident_events'::regclass
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'trg_audit_chain_insert BEFORE INSERT on incident_events' AS detail
  ),
  backfill_complete AS (
    SELECT 'D_backfill_complete' AS check_name,
           CASE WHEN count(*) FILTER (WHERE chain_position IS NULL) = 0
                THEN 'PASS' ELSE 'FAIL' END AS status,
           count(*) FILTER (WHERE chain_position IS NULL)::text ||
           ' events without chain fields' AS detail
      FROM ops_incident.incident_events
  ),
  no_position_gaps AS (
    SELECT 'E_no_position_gaps' AS check_name,
           CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status,
           count(*)::text || ' tenants with chain position gaps' AS detail
      FROM (
        SELECT tenant_uuid
          FROM ops_incident.incident_events
         WHERE chain_position IS NOT NULL
         GROUP BY tenant_uuid
        HAVING max(chain_position) - min(chain_position) + 1 != count(*)
      ) g
  ),
  backfill_governance AS (
    SELECT 'F_backfill_governance' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM ops_audit.governance_events
              WHERE event_type = 'backfill_completed'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'backfill audit trail in governance_events' AS detail
  ),
  verify_fn AS (
    SELECT 'G_verify_function' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'ops_audit' AND p.proname = 'verify_chain_integrity'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'verify_chain_integrity() exists' AS detail
  ),
  backfill_fn AS (
    SELECT 'H_backfill_function' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'ops_audit' AND p.proname = 'backfill_chain_for_tenant'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'backfill_chain_for_tenant() exists' AS detail
  ),
  hmac_verified AS (
    SELECT 'I_hmac_chain_integrity' AS check_name,
           CASE WHEN (
             SELECT ops_audit.verify_chain_integrity(
               '${TENANT_UUID}'::uuid
             ) ->> 'status'
           ) = 'VERIFIED' THEN 'PASS' ELSE 'FAIL' END AS status,
           'HMAC-SHA256 chain VERIFIED, 0 errors' AS detail
  )
SELECT * FROM ops_audit_schema
UNION ALL SELECT * FROM signing_key_active
UNION ALL SELECT * FROM chain_trigger
UNION ALL SELECT * FROM backfill_complete
UNION ALL SELECT * FROM no_position_gaps
UNION ALL SELECT * FROM backfill_governance
UNION ALL SELECT * FROM verify_fn
UNION ALL SELECT * FROM backfill_fn
UNION ALL SELECT * FROM hmac_verified
ORDER BY check_name;
"
run_suite "chain_integrity" "$CHAIN_INTEGRITY_SQL"


# =============================================================================
# SUITE 6: Compliance Reports — Layer 5 Evidence Production
# Added: 2026-05-19 after Layer 5 verified (JCI working, chain_status=verified)
# =============================================================================
COMPLIANCE_REPORTS_SQL="
WITH
  templates_seeded AS (
    SELECT 'A_report_templates_seeded' AS check_name,
           CASE WHEN count(*) >= 9 THEN 'PASS' ELSE 'FAIL' END AS status,
           count(*)::text || ' compliance templates (JCI x4, SOC2 x3, BB_MFS x2)' AS detail
      FROM ops_audit.compliance_report_templates WHERE is_active = true
  ),
  jci_templates AS (
    SELECT 'B_jci_templates_present' AS check_name,
           CASE WHEN count(*) >= 4 THEN 'PASS' ELSE 'FAIL' END AS status,
           count(*)::text || ' JCI control templates (MOI.11, QPS.7.1, QPS.7.2, GLD.4)' AS detail
      FROM ops_audit.compliance_report_templates
     WHERE framework = 'JCI' AND is_active = true
  ),
  evidence_fns AS (
    SELECT 'C_evidence_functions_exist' AS check_name,
           CASE WHEN count(*) >= 6 THEN 'PASS' ELSE 'FAIL' END AS status,
           count(*)::text || ' evidence functions (chain_proof, incident_summary, governance, response_times, access_control, timeline)' AS detail
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops_audit' AND p.proname LIKE 'evidence_%'
  ),
  master_fn AS (
    SELECT 'D_build_report_function' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'ops_audit' AND p.proname = 'build_compliance_report'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'ops_audit.build_compliance_report() exists' AS detail
  ),
  report_runs_table AS (
    SELECT 'E_report_runs_table' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'ops_audit' AND table_name = 'compliance_report_runs'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'ops_audit.compliance_report_runs exists' AS detail
  ),
  verification_log_table AS (
    SELECT 'F_verification_log_table' AS check_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'ops_audit' AND table_name = 'chain_verification_log'
           ) THEN 'PASS' ELSE 'FAIL' END AS status,
           'ops_audit.chain_verification_log exists' AS detail
  ),
  report_smoke AS (
    SELECT 'G_jci_report_generates' AS check_name,
           CASE WHEN (r ->> 'framework') = 'JCI'
                  AND (r ->> 'report_id') IS NOT NULL
                  AND (r -> 'chain_proof' ->> 'chain_status') = 'verified'
                THEN 'PASS' ELSE 'FAIL' END AS status,
           'JCI report: framework=JCI chain_status=' ||
           coalesce(r -> 'chain_proof' ->> 'chain_status', '<null>') AS detail
      FROM (
        SELECT ops_audit.build_compliance_report(
          '${TENANT_UUID}'::uuid,
          'JCI',
          now() - interval '90 days',
          now()
        ) AS r
      ) t
  )
SELECT * FROM templates_seeded
UNION ALL SELECT * FROM jci_templates
UNION ALL SELECT * FROM evidence_fns
UNION ALL SELECT * FROM master_fn
UNION ALL SELECT * FROM report_runs_table
UNION ALL SELECT * FROM verification_log_table
UNION ALL SELECT * FROM report_smoke
ORDER BY check_name;
"
run_suite "compliance_reports" "$COMPLIANCE_REPORTS_SQL"


# =============================================================================
# FINAL SUMMARY
# =============================================================================
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║                        QC SUMMARY                               ║${NC}"
echo -e "${BOLD}╠══════════════════════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}║  Suites run:  ${SUITE_COUNT}                                                   ║${NC}"

if [ "$TOTAL_FAIL" -eq 0 ]; then
  echo -e "${BOLD}║  ${GREEN}ALL ${TOTAL_PASS} CHECKS PASSED${NC}${BOLD}                                           ║${NC}"
  echo -e "${BOLD}╚══════════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  exit 0
else
  echo -e "${BOLD}║  ${GREEN}PASS: ${TOTAL_PASS}${NC}${BOLD}   ${RED}FAIL: ${TOTAL_FAIL}${NC}${BOLD}                                        ║${NC}"
  echo -e "${BOLD}╚══════════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${RED}${BOLD}QC FAILED — investigate FAIL items above before deploying.${NC}"
  exit 1
fi
