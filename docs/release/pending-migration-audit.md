# Pending migration audit

**GENERATED** by `tests/db/audit-pending.mjs`. Regenerate with
`node tests/db/setup-test-db.mjs && node tests/db/audit-pending.mjs`;
the diff is the change. Do not edit by hand.

Pending after `20261009013557`: **31 migrations**.

Every "creates" and "drops" figure below was read from the
PostgreSQL catalog before and after applying the file to a
disposable database. `data risk` is a reading of the SQL text and
is labelled as such. **Nothing here says anything about the live
project**: the repository has no base schema, so a file that
applies cleanly here can still meet a live column no fixture
reproduces.

## Order, outcome and reversibility

| # | migration | applies | re-runnable | creates | drops | data risk (read from SQL) |
|---|---|---|---|---|---|---|
| 1 | `20261009160000_batch5_freeze_customer_facing_content_once_sent.sql` | yes | yes | 1 functions, 1 triggers | — | drops a trigger |
| 2 | `20261010090000_batch7_1_tighten_remaining_admin_rpc_grants.sql` | yes | yes | — | — | revokes a privilege |
| 3 | `20261010091000_batch7_1_revoke_anon_writes_on_legacy_tables.sql` | yes | yes | — | — | revokes a privilege |
| 4 | `20261010120000_batch8_1_inventory_and_rental_sets.sql` | yes | yes | 10 tables, 2 views, 3 functions, 8 triggers, 10 policies, 30 indexes | — | drops a trigger, drops a view, drops a policy, revokes a privilege |
| 5 | `20261010121000_batch8_1_estimate_job_materials.sql` | yes | yes | 1 functions | — | drops a function (signature change), revokes a privilege |
| 6 | `20261010130000_batch8_1_stock_operations_contract_v1.sql` | yes | yes | 4 functions | — | drops a function (signature change), revokes a privilege |
| 7 | `20261010140000_batch8_1_reservations_units_and_crew_access.sql` | yes | yes | 3 tables, 5 functions, 2 triggers, 7 policies, 6 indexes | policies: admin_all on ns_material_stock_moves, admin_all on ns_stock_operations | drops a trigger, drops a view, drops a policy, revokes a privilege …+1 |
| 8 | `20261010141000_batch8_1_reservation_operations.sql` | yes | yes | 4 functions | — | revokes a privilege, updates rows (backfill) |
| 9 | `20261011090000_batch9_1_seasonal_set_identity_and_assignments.sql` | yes | yes | 1 tables, 1 views, 1 functions, 2 triggers, 4 policies, 7 indexes | policies: admin_all on ns_rental_sets, admin_all on ns_rental_set_events | drops a column, drops a trigger, drops a view, drops a policy …+2 |
| 10 | `20261011091000_batch9_1_seasonal_operations.sql` | yes | yes | 13 functions, 1 indexes | — | revokes a privilege, updates rows (backfill) |
| 11 | `20261011100000_batch9_1_permanent_lighting_materials.sql` | yes | yes | 5 tables, 1 views, 3 functions, 4 triggers, 9 policies, 13 indexes | — | drops a trigger, drops a view, drops a policy, revokes a privilege …+1 |
| 12 | `20261011101000_batch9_1_kit_and_sheet_operations.sql` | yes | yes | 10 functions | — | revokes a privilege, updates rows (backfill) |
| 13 | `20261011110000_batch10_1_load_planning.sql` | yes | yes | 10 tables, 1 views, 14 policies, 27 indexes | — | drops a view, drops a policy, revokes a privilege |
| 14 | `20261011111000_batch10_1_load_operations.sql` | yes | yes | 11 functions | — | revokes a privilege, deletes rows, updates rows (backfill) |
| 15 | `20261012090000_batch9_1_corrective_seasonal_review.sql` | yes | yes | 3 functions | functions: ns_seasonal_result(uuid,uuid,boolean) | drops a function (signature change), drops a view, revokes a privilege, adds a CHECK …+1 |
| 16 | `20261013090000_batch11_1_seasonal_corrective_round_two.sql` | yes | yes | 1 views, 2 functions | — | drops a view, revokes a privilege, adds a CHECK, updates rows (backfill) |
| 17 | `20261013100000_batch11_1_completion_and_evidence.sql` | yes | yes | 6 tables, 2 views, 8 functions, 7 triggers, 6 policies, 18 indexes | — | drops a trigger, drops a policy, revokes a privilege, adds a CHECK |
| 18 | `20261013110000_batch11_1_completion_operations.sql` | yes | yes | 12 functions | — | revokes a privilege, updates rows (backfill) |
| 19 | `20261014090000_batch10_1_corrective_load_contract.sql` | yes | yes | 1 tables, 5 functions, 1 policies, 2 indexes | functions: authorise_load_exception(text,text,date,text,text,uuid,uuid) | drops a function (signature change), drops a policy, revokes a privilege, deletes rows …+2 |
| 20 | `20261015090000_batch10_1_corrective_day_boundary_and_lock.sql` | yes | yes | 5 functions, 1 triggers | functions: confirm_load_plan(text,uuid,integer,text,text) | drops a function (signature change), drops a trigger, revokes a privilege, deletes rows …+1 |
| 21 | `20261016090000_batch12_1_dispatch_day_and_order.sql` | yes | yes | 3 tables, 9 functions, 3 policies, 6 indexes | — | drops a policy, revokes a privilege, deletes rows, updates rows (backfill) |
| 22 | `20261016100000_batch12_1_property_access_and_zones.sql` | yes | yes | 2 tables, 1 views, 6 functions, 2 policies, 3 indexes | — | drops a policy, revokes a privilege, updates rows (backfill) |
| 23 | `20261016110000_batch12_1_job_issues_and_notifications.sql` | yes | yes | 3 tables, 1 views, 8 functions, 3 policies, 7 indexes | — | drops a policy, revokes a privilege, updates rows (backfill) |
| 24 | `20261016120000_batch12_1_conflicts_stages_and_winter.sql` | yes | yes | 1 views, 5 functions | — | revokes a privilege |
| 25 | `20261017090000_batch13_1_customer_reports.sql` | yes | yes | 3 tables, 13 functions, 2 triggers, 9 indexes | — | drops a trigger, revokes a privilege, updates rows (backfill) |
| 26 | `20261017100000_batch13_1_customer_access.sql` | yes | yes | 3 tables, 11 functions, 8 indexes | — | revokes a privilege, updates rows (backfill) |
| 27 | `20261017110000_batch13_1_report_delivery.sql` | yes | yes | 1 tables, 5 functions, 4 indexes | — | revokes a privilege, updates rows (backfill) |
| 28 | `20261017120000_batch13_1_payment_boundary.sql` | yes | yes | 1 tables, 4 functions, 3 indexes | — | revokes a privilege |
| 29 | `20261018090000_batch15_1_crew_scope_reconciliation.sql` | yes | yes | 6 functions | — | revokes a privilege, deletes rows, updates rows (backfill) |
| 30 | `20261018100000_batch15_1_revoke_public_execute_on_trigger_functions.sql` | yes | yes | — | — | revokes a privilege |
| 31 | `20261018110000_batch15_1_rls_on_handover_tables.sql` | yes | yes | 8 policies | — | drops a policy |

## Live-only tables each file touches

These exist only in the live project. A file naming one is
**unverified locally beyond what the fixture reproduces**, and the
`guarded` column says whether the file introspects with
`to_regclass` before touching anything.

| migration | live-only tables named | guarded |
|---|---|---|
| `20261009160000_batch5_freeze_customer_facing_content_once_sent.sql` | ns_quotes | — |
| `20261010120000_batch8_1_inventory_and_rental_sets.sql` | ns_jobs, customers, properties, services | — |
| `20261010121000_batch8_1_estimate_job_materials.sql` | ns_jobs, job_measurements, services | — |
| `20261010140000_batch8_1_reservations_units_and_crew_access.sql` | ns_jobs | — |
| `20261011090000_batch9_1_seasonal_set_identity_and_assignments.sql` | ns_jobs, customers, properties | — |
| `20261011091000_batch9_1_seasonal_operations.sql` | customers, app_settings | — |
| `20261011100000_batch9_1_permanent_lighting_materials.sql` | ns_jobs, services | — |
| `20261011101000_batch9_1_kit_and_sheet_operations.sql` | job_measurements, services | — |
| `20261011110000_batch10_1_load_planning.sql` | ns_jobs, services | — |
| `20261011111000_batch10_1_load_operations.sql` | ns_jobs, job_measurements, services | — |
| `20261012090000_batch9_1_corrective_seasonal_review.sql` | customers | — |
| `20261013100000_batch11_1_completion_and_evidence.sql` | ns_jobs, job_attachments, ns_change_orders, job_measurements, services | yes |
| `20261013110000_batch11_1_completion_operations.sql` | ns_jobs, job_attachments, ns_quotes, ns_change_orders, services | — |
| `20261014090000_batch10_1_corrective_load_contract.sql` | ns_jobs, customers | — |
| `20261015090000_batch10_1_corrective_day_boundary_and_lock.sql` | ns_jobs, customers, app_settings | yes |
| `20261016090000_batch12_1_dispatch_day_and_order.sql` | ns_jobs, customers | — |
| `20261016100000_batch12_1_property_access_and_zones.sql` | ns_jobs, properties | — |
| `20261016110000_batch12_1_job_issues_and_notifications.sql` | ns_jobs, customers, notifications, app_settings | yes |
| `20261016120000_batch12_1_conflicts_stages_and_winter.sql` | ns_jobs, customers, app_settings, job_measurements, services | yes |
| `20261017090000_batch13_1_customer_reports.sql` | ns_jobs, customers, properties, ns_quotes, app_settings, ns_change_orders, quote_line_items, services | yes |
| `20261017100000_batch13_1_customer_access.sql` | ns_jobs, customers, job_attachments, app_settings | yes |
| `20261017110000_batch13_1_report_delivery.sql` | ns_jobs, customers, notifications | yes |
| `20261017120000_batch13_1_payment_boundary.sql` | ns_jobs, ns_quotes, app_settings | yes |
| `20261018090000_batch15_1_crew_scope_reconciliation.sql` | ns_jobs | — |

## The grant surface after the whole chain

Functions in `public`: **160**.
Executable by `anon`: **5**.

### Every function `anon` may execute

Each one must be a deliberate decision with a reason. Anything
here that is not on the list in the release findings is a defect.

| function | anon | authenticated | service_role | created by |
|---|---|---|---|---|
| `fixture_event_trigger_fn()` | yes | yes | yes | fixture stand-in |
| `get_customer_report(text,uuid)` | yes | yes | yes | **the pending chain** |
| `is_admin()` | yes | yes | yes | fixture stand-in |
| `list_customer_documents(text)` | yes | yes | yes | **the pending chain** |
| `request_customer_document(text,uuid,uuid)` | yes | yes | yes | **the pending chain** |

### Tables `anon` may read or write

| table | select | insert | created by |
|---|---|---|---|
| `job_requests` | yes | — | fixture stand-in |
| `jobs` | yes | — | fixture stand-in |
| `quotes` | yes | — | fixture stand-in |

### Tables a logged-in caller may write

A write grant here is only safe where RLS or a definer function
stands in front of it. `rls` is the table's own row-level
security flag, read from `pg_class`.

| table | insert | update | delete | rls |
|---|---|---|---|---|
| `app_settings` | yes | yes | yes | — |
| `customers` | yes | yes | yes | — |
| `job_attachments` | yes | yes | yes | — |
| `job_measurements` | yes | yes | yes | — |
| `job_requests` | yes | yes | yes | — |
| `jobs` | yes | yes | yes | — |
| `ns_crew_members` | yes | yes | yes | yes |
| `ns_jobs` | yes | yes | yes | — |
| `ns_material_levels` | yes | yes | yes | yes |
| `ns_materials` | yes | yes | yes | yes |
| `ns_purchase_order_lines` | yes | yes | yes | yes |
| `ns_purchase_orders` | yes | yes | yes | yes |
| `ns_rental_set_events` | yes | — | — | yes |
| `ns_rental_sets` | yes | yes | yes | yes |
| `ns_service_material_usage` | yes | yes | yes | yes |
| `ns_stock_locations` | yes | yes | yes | yes |
| `ns_suppliers` | yes | yes | yes | yes |
| `properties` | yes | yes | yes | — |
| `quotes` | yes | yes | yes | — |
| `services` | yes | yes | yes | — |

### Tables with row-level security OFF

Split by who created the table, because the two halves mean
different things. A **fixture** table is a local stand-in for a
live-only table: its RLS and policies here are whatever the
fixture bothered to set and say NOTHING about the live project. A
**repository** table is one the pending chain creates, and its
state here is its state live.

**Created by the pending chain** — this is the real list:

None. Every table the chain creates has RLS enabled.

Created by a fixture (says nothing about live):

`app_settings`, `customers`, `job_attachments`, `job_measurements`, `job_requests`, `jobs`, `notifications`, `ns_change_orders`, `ns_jobs`, `ns_quotes`, `properties`, `quote_line_items`, `quotes`, `services`

#### Policy coverage, chain-created tables

| table | rls | policies | authenticated may select |
|---|---|---|---|
| `ns_completion_reports` | yes | 1 | yes |
| `ns_crew_members` | yes | 2 | yes |
| `ns_customer_grant_reads` | yes | 1 | yes |
| `ns_customer_grants` | yes | 1 | — |
| `ns_day_reconciliation_lines` | yes | 1 | yes |
| `ns_day_reconciliations` | yes | 1 | yes |
| `ns_dispatch_days` | yes | 1 | yes |
| `ns_dispatch_operations` | yes | 1 | yes |
| `ns_dispatch_order` | yes | 1 | yes |
| `ns_document_access_tickets` | yes | 1 | yes |
| `ns_evidence_exceptions` | yes | 1 | yes |
| `ns_evidence_policies` | yes | 1 | yes |
| `ns_evidence_publications` | yes | 1 | yes |
| `ns_handover_operations` | yes | 1 | yes |
| `ns_job_completion_corrections` | yes | 1 | yes |
| `ns_job_completions` | yes | 1 | yes |
| `ns_job_consumptions` | yes | 1 | yes |
| `ns_job_dispatch_state` | yes | 1 | yes |
| `ns_job_evidence` | yes | 1 | yes |
| `ns_job_issues` | yes | 1 | yes |
| `ns_job_load_overrides` | yes | 2 | yes |
| `ns_job_material_sheet_lines` | yes | 2 | yes |
| `ns_job_material_sheets` | yes | 2 | yes |
| `ns_job_vehicle_assignments` | yes | 2 | yes |
| `ns_kit_sheet_lines` | yes | 2 | yes |
| `ns_kit_sheets` | yes | 2 | yes |
| `ns_load_exceptions` | yes | 1 | yes |
| `ns_load_manual_keeps` | yes | 1 | yes |
| `ns_load_operations` | yes | 1 | yes |
| `ns_load_plan_lines` | yes | 1 | yes |
| `ns_load_plans` | yes | 1 | yes |
| `ns_material_levels` | yes | 2 | yes |
| `ns_material_offcuts` | yes | 1 | yes |
| `ns_material_stock_moves` | yes | 1 | yes |
| `ns_materials` | yes | 1 | yes |
| `ns_notification_requests` | yes | 1 | — |
| `ns_payment_requests` | yes | 1 | yes |
| `ns_property_access` | yes | 1 | — |
| `ns_property_work_zones` | yes | 1 | yes |
| `ns_purchase_order_lines` | yes | 1 | yes |
| `ns_purchase_orders` | yes | 1 | yes |
| `ns_rental_set_events` | yes | 1 | — |
| `ns_rental_sets` | yes | 2 | yes |
| `ns_report_deliveries` | yes | 1 | yes |
| `ns_seasonal_assignments` | yes | 1 | yes |
| `ns_service_load_rules` | yes | 2 | yes |
| `ns_service_material_usage` | yes | 1 | yes |
| `ns_stock_locations` | yes | 1 | yes |
| `ns_stock_operations` | yes | 1 | yes |
| `ns_stock_reservations` | yes | 1 | yes |
| `ns_suppliers` | yes | 1 | yes |
| `ns_vehicle_baselines` | yes | 2 | yes |

### The private columns, checked by name

| table | column | authenticated may select | anon may select |
|---|---|---|---|
| `ns_property_access` | `access_code` | — | — |
| `ns_property_access` | `internal_note` | — | — |
| `ns_property_access` | `entrance_note` | yes | — |
| `ns_property_access` | `customer_note` | yes | — |

`access_code` and `internal_note` must read **no** for both, or
13.1 §3.6 and 12.1's private-column decision have been undone.

---

NO MIGRATION IN THIS REPOSITORY HAS BEEN APPLIED TO THE LIVE
PROJECT. This audit was produced on a disposable database and
proves things about PostgreSQL, not about production.
