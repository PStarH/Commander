#!/bin/sh
set -eu

create_fixture_role() {
  role_name=$1
  role_password=$2
  role_attributes=$3
  # The runner generates hexadecimal passwords, so embedding the value cannot
  # alter this fixture-only SQL command.
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --command "CREATE ROLE $role_name LOGIN NOSUPERUSER NOCREATEDB NOREPLICATION $role_attributes PASSWORD '$role_password';"
}

create_fixture_role commander_owner "$FIXTURE_OWNER_PASSWORD" "CREATEROLE INHERIT BYPASSRLS"
create_fixture_role commander_app "$FIXTURE_APP_PASSWORD" "NOCREATEROLE NOINHERIT NOBYPASSRLS"
create_fixture_role commander_tenant_authority "$FIXTURE_TENANT_AUTHORITY_PASSWORD" "NOCREATEROLE NOINHERIT NOBYPASSRLS"
create_fixture_role commander_scheduler "$FIXTURE_SCHEDULER_PASSWORD" "NOCREATEROLE NOINHERIT BYPASSRLS"
create_fixture_role commander_worker "$FIXTURE_WORKER_PASSWORD" "NOCREATEROLE NOINHERIT NOBYPASSRLS"
create_fixture_role commander_adapter_ops "$FIXTURE_ADAPTER_OPS_PASSWORD" "NOCREATEROLE NOINHERIT NOBYPASSRLS"
