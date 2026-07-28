#!/bin/sh
set -eu

create_fixture_role() {
  role_name=$1
  role_password=$2
  # Defensively escape any single quote in the password before embedding it in SQL.
  role_password_escaped=$(printf '%s' "$role_password" | sed "s/'/''/g")
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --command "CREATE ROLE $role_name LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '$role_password_escaped';"
}

create_fixture_role fixture_owner "$FIXTURE_OWNER_PASSWORD"
create_fixture_role fixture_app "$FIXTURE_APP_PASSWORD"
create_fixture_role fixture_tenant_authority "$FIXTURE_TENANT_AUTHORITY_PASSWORD"
create_fixture_role fixture_scheduler "$FIXTURE_SCHEDULER_PASSWORD"
create_fixture_role fixture_worker "$FIXTURE_WORKER_PASSWORD"
create_fixture_role fixture_adapter_ops "$FIXTURE_ADAPTER_OPS_PASSWORD"
