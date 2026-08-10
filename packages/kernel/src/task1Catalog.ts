import { createHash } from 'node:crypto';
import {
  AUTHORITY_CLASSIFIER_MANIFEST_SHA256,
  AUTHORITY_CLASSIFIER_MANIFEST_V1,
} from './authorityClassifierManifest.js';
import {
  canonicalBootstrapJson,
  TASK1_DATABASE_ROLES,
  type BootstrapIdentitiesV1,
  type BootstrapIdentityV1,
  type DatabasePeerBindingV1,
  type PrebootstrapInventoryV1,
} from './canonicalBootstrap.js';
import { KERNEL_TASK1_BASELINE_MIGRATIONS, KERNEL_TASK1_CLOSURE_MIGRATIONS } from './migrations.js';
import type { SqlClient } from './postgres.js';

type JsonRecord = Record<string, unknown>;

export interface Task1CatalogBootstrapContext {
  sessionUser: string;
  authority: BootstrapIdentityV1;
  bootstrapSuperuser: BootstrapIdentityV1;
}

export type Task1CatalogOriginKind = 'E1' | 'E2' | 'legacy';
export type Task1CatalogPostconditionStage =
  'historical' | 'hardened' | 'lifecycle' | 'expand' | 'enforce';

export type Task1LockedCatalogStage = 'historical' | 'hardened' | 'lifecycle';

export interface Task1LockedCatalogStateVerification {
  stage: Task1LockedCatalogStage;
  classification: Task1CatalogOriginKind;
  bootstrapIdentities: BootstrapIdentitiesV1 | null;
  databasePeerBinding: DatabasePeerBindingV1;
  manifestSourceJcs: string;
  observed: PrebootstrapInventoryV1;
  previous?: PrebootstrapInventoryV1;
}

const COMMANDER_NAME_PREDICATE = `substr(%s, 1, 10) COLLATE "C" = 'commander_'`;

const TASK1_DATABASE_IDENTITY_SENTINELS = Object.freeze({
  oid: 'task1_database_identity/v1:oid',
  name: 'task1_database_identity/v1:name',
});

const TASK1_BOOTSTRAP_IDENTITY_SENTINELS = Object.freeze({
  authorityOid: 'task1_bootstrap_identity/v1:authority-oid',
  authorityName: 'task1_bootstrap_identity/v1:authority-name',
  bootstrapSuperuserOid: 'task1_bootstrap_identity/v1:bootstrap-superuser-oid',
  bootstrapSuperuserName: 'task1_bootstrap_identity/v1:bootstrap-superuser-name',
});

const TASK1_CATALOG_NORMALIZATION_SCHEMA = Object.freeze({
  format: 'task1_catalog_normalization/v1',
  databaseIdentity: TASK1_DATABASE_IDENTITY_SENTINELS,
  paths: [
    'databaseIdentity.oid',
    'databaseIdentity.name',
    'databaseAcl[*].objectIdentity',
    'roleSettings[*].database',
  ],
});

const TASK1_BOOTSTRAP_PLACEHOLDER_SCHEMA = Object.freeze({
  format: 'bootstrap_identity_placeholders/v1',
  paths: ['authority.oid', 'authority.name', 'bootstrapSuperuser.oid', 'bootstrapSuperuser.name'],
});

const TASK1_RUNTIME_GRANTEES = [
  'PUBLIC',
  'commander_adapter_ops',
  'commander_app',
  'commander_scheduler',
  'commander_tenant_authority',
  'commander_worker',
] as const;

const TASK1_OWNER_ONLY_RELATIONS = [
  'public.commander_kernel_migrations',
  'public.commander_worker_allowed_tenants',
  'public.commander_worker_claim_secrets',
  'public.commander_tenant_authority_allowed_tenants',
  'public.commander_app_tenant_contexts',
  'public.commander_tenant_cutover_state',
  'public.commander_tenant_cutover_operations',
  'public.commander_tenant_cutover_rollout_proofs',
] as const;

export const TASK1_CATALOG_HARDENING_SQL = `/* task1-catalog:hardening */
REVOKE ALL PRIVILEGES ON TABLE
  public.commander_kernel_migrations,
  public.commander_worker_allowed_tenants,
  public.commander_worker_claim_secrets
FROM PUBLIC, commander_adapter_ops, commander_app, commander_scheduler,
  commander_tenant_authority, commander_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE commander_owner IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES
  FROM PUBLIC, commander_adapter_ops, commander_app, commander_scheduler,
    commander_tenant_authority, commander_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE commander_owner IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES
  FROM PUBLIC, commander_adapter_ops, commander_app, commander_scheduler,
    commander_tenant_authority, commander_worker;`;

export async function applyTask1CatalogHardening(client: SqlClient): Promise<void> {
  await client.query(TASK1_CATALOG_HARDENING_SQL);
}

export const TASK1_CATALOG_QUERIES = Object.freeze({
  identity: `/* task1-catalog:identity */
SELECT (current_setting('server_version_num')::integer / 10000)::text || '.' ||
         (current_setting('server_version_num')::integer % 100)::text AS postgres_version,
       control.catalog_version_no::text AS catalog_version,
       database.oid::text AS database_oid,
       database.datname::text AS database_name,
       pg_catalog.to_regclass('public.commander_kernel_migrations') IS NOT NULL AS ledger_exists
FROM pg_catalog.pg_database AS database
CROSS JOIN pg_catalog.pg_control_system() AS control
WHERE database.datname = pg_catalog.current_database()`,

  ledger: `/* task1-catalog:ledger */
SELECT id::text AS id, checksum::text AS checksum
FROM public.commander_kernel_migrations
ORDER BY id COLLATE "C", checksum COLLATE "C"`,

  namespaces: `/* task1-catalog:namespaces */
SELECT namespace.nspname::text AS schema,
       pg_catalog.pg_get_userbyid(namespace.nspowner)::text AS owner,
       COALESCE((
         SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END,
           'grantor', grantor.rolname,
           'privilege', acl.privilege_type,
           'grantable', acl.is_grantable
         ) ORDER BY CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END COLLATE "C",
                    grantor.rolname COLLATE "C", acl.privilege_type COLLATE "C", acl.is_grantable)
         FROM pg_catalog.aclexplode(COALESCE(namespace.nspacl,
           pg_catalog.acldefault('n', namespace.nspowner))) AS acl
         LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
         JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = acl.grantor
       ), '[]'::jsonb) AS acl
FROM pg_catalog.pg_namespace AS namespace
WHERE substr(namespace.nspname, 1, 10) COLLATE "C" = 'commander_'
ORDER BY namespace.nspname COLLATE "C"`,

  relations: `/* task1-catalog:relations */
SELECT namespace.nspname::text AS schema,
       relation.relname::text AS name,
       relation.relkind::text AS kind,
       pg_catalog.pg_get_userbyid(relation.relowner)::text AS owner,
       relation.relpersistence::text AS persistence,
       COALESCE(tablespace.spcname, '')::text AS tablespace,
       relation.relrowsecurity AS "rowSecurity",
       relation.relforcerowsecurity AS "forceRowSecurity",
       relation.relreplident::text AS "replicaIdentity",
       COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END,
         'grantor', grantor.rolname,
         'privilege', acl.privilege_type,
         'grantable', acl.is_grantable
       ) ORDER BY CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END COLLATE "C",
                  grantor.rolname COLLATE "C", acl.privilege_type COLLATE "C", acl.is_grantable)
         FROM pg_catalog.aclexplode(COALESCE(relation.relacl,
           pg_catalog.acldefault(CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
             relation.relowner))) AS acl
         LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
         JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = acl.grantor
       ), '[]'::jsonb) AS acl,
       CASE WHEN relation.relispartition
         THEN pg_catalog.pg_get_expr(relation.relpartbound, relation.oid, false) ELSE NULL END AS "partitionBound",
       CASE WHEN relation.relkind = 'p'
         THEN pg_catalog.pg_get_partkeydef(relation.oid) ELSE NULL END AS "partitionKey",
       COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'name', attribute.attname,
         'position', attribute.attnum,
         'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
         'collation', CASE WHEN attribute.attcollation = 0 THEN NULL
           ELSE collation_namespace.nspname || '.' || collation_entry.collname END,
         'notNull', attribute.attnotnull,
         'default', pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid, false),
         'generated', attribute.attgenerated::text,
         'identity', attribute.attidentity::text,
         'compression', attribute.attcompression::text,
         'storage', attribute.attstorage::text,
         'statistics', attribute.attstattarget,
         'acl', COALESCE(attribute.attacl::text[], ARRAY[]::text[])
       ) ORDER BY attribute.attnum)
       FROM pg_catalog.pg_attribute AS attribute
       LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
         ON attribute_default.adrelid = attribute.attrelid
        AND attribute_default.adnum = attribute.attnum
       LEFT JOIN pg_catalog.pg_collation AS collation_entry
         ON collation_entry.oid = attribute.attcollation
       LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
         ON collation_namespace.oid = collation_entry.collnamespace
       WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
       ), '[]'::jsonb) AS columns,
       COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'name', constraint_entry.conname,
         'type', constraint_entry.contype::text,
         'definition', pg_catalog.pg_get_constraintdef(constraint_entry.oid, false),
         'validated', constraint_entry.convalidated,
         'deferrable', constraint_entry.condeferrable,
         'deferred', constraint_entry.condeferred
       ) ORDER BY constraint_entry.conname COLLATE "C", constraint_entry.contype)
       FROM pg_catalog.pg_constraint AS constraint_entry
       WHERE constraint_entry.conrelid = relation.oid
       ), '[]'::jsonb) AS constraints,
       COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'name', index_relation.relname,
         'definition', pg_catalog.pg_get_indexdef(index_relation.oid, 0, false)
       ) ORDER BY index_relation.relname COLLATE "C")
       FROM pg_catalog.pg_index AS index_entry
       JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_entry.indexrelid
       WHERE index_entry.indrelid = relation.oid), '[]'::jsonb) AS indexes
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
LEFT JOIN pg_catalog.pg_tablespace AS tablespace ON tablespace.oid = relation.reltablespace
WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
  AND namespace.nspname NOT LIKE 'pg_toast%'
  AND (substr(relation.relname, 1, 10) COLLATE "C" = 'commander_'
    OR substr(namespace.nspname, 1, 10) COLLATE "C" = 'commander_')
ORDER BY namespace.nspname COLLATE "C", relation.relkind, relation.relname COLLATE "C"`,

  functions: `/* task1-catalog:functions */
SELECT namespace.nspname::text AS schema,
       procedure.proname::text AS name,
       pg_catalog.pg_get_function_identity_arguments(procedure.oid)::text AS "identityArguments",
       pg_catalog.pg_get_function_result(procedure.oid)::text AS result,
       pg_catalog.pg_get_userbyid(procedure.proowner)::text AS owner,
       language.lanname::text AS language,
       procedure.provolatile::text AS volatility,
       procedure.proisstrict AS strict,
       procedure.proleakproof AS leakproof,
       procedure.proparallel::text AS parallel,
       procedure.prosecdef AS "securityDefiner",
       COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END,
         'grantor', grantor.rolname,
         'privilege', acl.privilege_type,
         'grantable', acl.is_grantable
       ) ORDER BY CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END COLLATE "C",
                  grantor.rolname COLLATE "C", acl.privilege_type COLLATE "C", acl.is_grantable)
         FROM pg_catalog.aclexplode(COALESCE(procedure.proacl,
           pg_catalog.acldefault('f', procedure.proowner))) AS acl
         LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
         JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = acl.grantor
       ), '[]'::jsonb) AS acl,
       COALESCE(procedure.proconfig, ARRAY[]::text[]) AS config,
       replace(pg_catalog.pg_get_functiondef(procedure.oid), E'\r\n', E'\n') AS "functionDefinition"
FROM pg_catalog.pg_proc AS procedure
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
JOIN pg_catalog.pg_language AS language ON language.oid = procedure.prolang
WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
  AND (substr(procedure.proname, 1, 10) COLLATE "C" = 'commander_'
    OR substr(namespace.nspname, 1, 10) COLLATE "C" = 'commander_'
    OR (namespace.nspname = 'public' AND procedure.proname IN (
      'reject_tenant_cutover_operation_mutation',
      'reject_tenant_cutover_rollout_proof_mutation'
    )))
ORDER BY namespace.nspname COLLATE "C", procedure.proname COLLATE "C",
         pg_catalog.pg_get_function_identity_arguments(procedure.oid) COLLATE "C"`,

  types: `/* task1-catalog:types */
SELECT namespace.nspname::text AS schema, type.typname::text AS name,
       type.typtype::text AS kind, type.typcategory::text AS category,
       pg_catalog.pg_get_userbyid(type.typowner)::text AS owner,
       COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END,
         'grantor', grantor.rolname,
         'privilege', acl.privilege_type,
         'grantable', acl.is_grantable
       ) ORDER BY CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END COLLATE "C",
                  grantor.rolname COLLATE "C", acl.privilege_type COLLATE "C", acl.is_grantable)
         FROM pg_catalog.aclexplode(COALESCE(type.typacl,
           pg_catalog.acldefault('T', type.typowner))) AS acl
         LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
         JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = acl.grantor
       ), '[]'::jsonb) AS acl,
       CASE WHEN type.typtype = 'd' THEN pg_catalog.format_type(type.typbasetype, type.typtypmod) ELSE NULL END AS "domainBase",
       COALESCE((SELECT pg_catalog.jsonb_agg(enum.enumlabel ORDER BY enum.enumsortorder)
         FROM pg_catalog.pg_enum AS enum WHERE enum.enumtypid = type.oid), '[]'::jsonb) AS labels,
       COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'name', attribute.attname, 'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
       ) ORDER BY attribute.attnum)
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = type.typrelid AND attribute.attnum > 0 AND NOT attribute.attisdropped), '[]'::jsonb) AS attributes
FROM pg_catalog.pg_type AS type
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type.typnamespace
WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
  AND (substr(type.typname, 1, 10) COLLATE "C" = 'commander_'
    OR substr(namespace.nspname, 1, 10) COLLATE "C" = 'commander_')
ORDER BY namespace.nspname COLLATE "C", type.typtype, type.typname COLLATE "C"`,

  extensions: `/* task1-catalog:extensions */
SELECT extension.extname::text AS name, extension.extversion::text AS version,
       namespace.nspname::text AS schema, extension.extrelocatable AS relocatable,
       COALESCE((SELECT pg_catalog.jsonb_agg(
         pg_catalog.pg_describe_object(dependency.classid, dependency.objid, dependency.objsubid)
         ORDER BY dependency.classid, dependency.objid, dependency.objsubid)
         FROM pg_catalog.pg_depend AS dependency
         WHERE dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
           AND dependency.refobjid = extension.oid AND dependency.deptype = 'e'), '[]'::jsonb) AS members
FROM pg_catalog.pg_extension AS extension
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
WHERE substr(extension.extname, 1, 10) COLLATE "C" = 'commander_'
   OR substr(namespace.nspname, 1, 10) COLLATE "C" = 'commander_'
ORDER BY extension.extname COLLATE "C"`,

  policies: `/* task1-catalog:policies */
SELECT namespace.nspname::text AS schema, relation.relname::text AS relation,
       policy.polname::text AS name, policy.polcmd::text AS command,
       policy.polpermissive AS permissive,
       COALESCE((SELECT pg_catalog.jsonb_agg(role.rolname ORDER BY role.rolname COLLATE "C")
         FROM pg_catalog.unnest(policy.polroles) AS role_oid(oid)
         JOIN pg_catalog.pg_roles AS role ON role.oid = role_oid.oid), '[]'::jsonb) AS roles,
       pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) AS using,
       pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) AS "withCheck"
FROM pg_catalog.pg_policy AS policy
JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE substr(relation.relname, 1, 10) COLLATE "C" = 'commander_'
   OR substr(namespace.nspname, 1, 10) COLLATE "C" = 'commander_'
ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", policy.polname COLLATE "C"`,

  triggers: `/* task1-catalog:triggers */
SELECT namespace.nspname::text AS schema, relation.relname::text AS relation,
       trigger.tgname::text AS name, trigger.tgenabled::text AS enabled,
       pg_catalog.pg_get_triggerdef(trigger.oid, false)::text AS definition,
       function_namespace.nspname || '.' || function.proname || '(' ||
         pg_catalog.pg_get_function_identity_arguments(function.oid) || ')' AS function
FROM pg_catalog.pg_trigger AS trigger
JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_proc AS function ON function.oid = trigger.tgfoid
JOIN pg_catalog.pg_namespace AS function_namespace ON function_namespace.oid = function.pronamespace
WHERE NOT trigger.tgisinternal AND (
  substr(relation.relname, 1, 10) COLLATE "C" = 'commander_'
  OR substr(namespace.nspname, 1, 10) COLLATE "C" = 'commander_')
ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C", trigger.tgname COLLATE "C"`,

  roles: `/* task1-catalog:roles */
SELECT role.rolname::text AS name, role.rolsuper AS superuser, role.rolinherit AS inherit,
       role.rolcreaterole AS "createRole", role.rolcreatedb AS "createDatabase",
       role.rolcanlogin AS "canLogin", role.rolreplication AS replication,
       role.rolbypassrls AS "bypassRls", role.rolconnlimit AS "connectionLimit",
       CASE
         WHEN role.rolvaliduntil IS NULL THEN NULL
         WHEN role.rolvaliduntil = 'infinity'::timestamptz THEN 'infinity'
         WHEN role.rolvaliduntil = '-infinity'::timestamptz THEN '-infinity'
         ELSE pg_catalog.to_char(role.rolvaliduntil AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
       END AS "validUntil",
       COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'name', split_part(setting, '=', 1),
         'value', substr(setting, length(split_part(setting, '=', 1)) + 2)
       ) ORDER BY split_part(setting, '=', 1) COLLATE "C")
         FROM pg_catalog.unnest(COALESCE(role.rolconfig, ARRAY[]::text[])) AS setting), '[]'::jsonb) AS "roleConfig"
FROM pg_catalog.pg_roles AS role
WHERE substr(role.rolname, 1, 10) COLLATE "C" = 'commander_'
ORDER BY role.rolname COLLATE "C"`,

  memberships: `/* task1-catalog:memberships */
SELECT granted.rolname::text AS role, member.rolname::text AS member,
       grantor.rolname::text AS grantor, membership.admin_option AS "adminOption",
       membership.inherit_option AS "inheritOption", membership.set_option AS "setOption"
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = membership.grantor
WHERE substr(granted.rolname, 1, 10) COLLATE "C" = 'commander_'
   OR substr(member.rolname, 1, 10) COLLATE "C" = 'commander_'
ORDER BY granted.rolname COLLATE "C", member.rolname COLLATE "C", grantor.rolname COLLATE "C",
         membership.admin_option, membership.inherit_option, membership.set_option`,

  roleSettings: `/* task1-catalog:role-settings */
SELECT CASE WHEN setting.setdatabase = 0 THEN '*' ELSE database.datname END AS database,
       CASE WHEN setting.setrole = 0 THEN '*' ELSE role.rolname END AS role,
       COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'name', split_part(value, '=', 1),
         'value', substr(value, length(split_part(value, '=', 1)) + 2)
       ) ORDER BY split_part(value, '=', 1) COLLATE "C")
         FROM pg_catalog.unnest(setting.setconfig) AS value), '[]'::jsonb) AS settings
FROM pg_catalog.pg_db_role_setting AS setting
LEFT JOIN pg_catalog.pg_database AS database ON database.oid = setting.setdatabase
LEFT JOIN pg_catalog.pg_roles AS role ON role.oid = setting.setrole
WHERE setting.setdatabase IN (0, (SELECT oid FROM pg_catalog.pg_database
                                  WHERE datname = pg_catalog.current_database()))
  AND (setting.setrole = 0 OR substr(role.rolname, 1, 10) COLLATE "C" = 'commander_')
ORDER BY (CASE WHEN setting.setdatabase = 0 THEN '*' ELSE database.datname END) COLLATE "C",
         (CASE WHEN setting.setrole = 0 THEN '*' ELSE role.rolname END) COLLATE "C"`,

  databaseAcl: `/* task1-catalog:database-acl */
SELECT 'database'::text AS "objectKind", database.datname::text AS "objectIdentity",
       owner.rolname::text AS owner,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
       grantor.rolname::text AS grantor, acl.privilege_type::text AS privilege,
       acl.is_grantable AS grantable
FROM pg_catalog.pg_database AS database
JOIN pg_catalog.pg_roles AS owner ON owner.oid = database.datdba
CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(database.datacl,
  pg_catalog.acldefault('d', database.datdba))) AS acl
LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = acl.grantor
WHERE database.datname = pg_catalog.current_database()
ORDER BY (CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END) COLLATE "C",
         grantor.rolname COLLATE "C", acl.privilege_type COLLATE "C", acl.is_grantable`,

  schemaAcls: `/* task1-catalog:schema-acls */
SELECT 'schema'::text AS "objectKind", namespace.nspname::text AS "objectIdentity",
       owner.rolname::text AS owner,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
       grantor.rolname::text AS grantor, acl.privilege_type::text AS privilege,
       acl.is_grantable AS grantable
FROM pg_catalog.pg_namespace AS namespace
JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(namespace.nspacl,
  pg_catalog.acldefault('n', namespace.nspowner))) AS acl
LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = acl.grantor
WHERE namespace.nspname = 'public'
   OR substr(namespace.nspname, 1, 10) COLLATE "C" = 'commander_'
ORDER BY namespace.nspname COLLATE "C",
         (CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END) COLLATE "C",
         grantor.rolname COLLATE "C", acl.privilege_type COLLATE "C", acl.is_grantable`,

  defaultAcls: `/* task1-catalog:default-acls */
SELECT COALESCE(namespace.nspname, '*')::text AS namespace,
       owner.rolname::text AS owner, defaults.defaclobjtype::text AS "objectType",
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
       grantor.rolname::text AS grantor, acl.privilege_type::text AS privilege,
       acl.is_grantable AS grantable
FROM pg_catalog.pg_default_acl AS defaults
JOIN pg_catalog.pg_roles AS owner ON owner.oid = defaults.defaclrole
LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = defaults.defaclnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS acl
LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = acl.grantor
WHERE substr(owner.rolname, 1, 10) COLLATE "C" = 'commander_'
   OR substr(namespace.nspname, 1, 10) COLLATE "C" = 'commander_'
ORDER BY COALESCE(namespace.nspname, '*') COLLATE "C", owner.rolname COLLATE "C",
         defaults.defaclobjtype,
         (CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END) COLLATE "C",
         grantor.rolname COLLATE "C", acl.privilege_type COLLATE "C", acl.is_grantable`,
});

function fail(code: string): never {
  throw new Error(code);
}

function asRecord(value: unknown, code = 'TASK1_CATALOG_INVALID'): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(code);
  return value as JsonRecord;
}

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith('[') || trimmed.startsWith('{'))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    fail('TASK1_CATALOG_INVALID_JSON');
  }
}

function normalizeValue(value: unknown): unknown {
  const decoded = parsed(value);
  if (Array.isArray(decoded)) return decoded.map(normalizeValue);
  if (decoded && typeof decoded === 'object') {
    return Object.fromEntries(
      Object.entries(decoded as JsonRecord).map(([key, child]) => [key, normalizeValue(child)]),
    );
  }
  return decoded;
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizedRows(rows: readonly unknown[]): JsonRecord[] {
  return rows.map((row) => normalizeValue(asRecord(row)) as JsonRecord);
}

function quoteIdentifier(value: string): string {
  if (value.includes('\0')) fail('TASK1_CATALOG_IDENTIFIER_INVALID');
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizeFunction(row: JsonRecord): JsonRecord {
  const definition = String(row.functionDefinition ?? '').replaceAll('\r\n', '\n');
  if (!definition) fail('TASK1_CATALOG_FUNCTION_DEFINITION_MISSING');
  const { functionDefinition: _definition, ...catalog } = row;
  return {
    ...catalog,
    config: Array.isArray(catalog.config) ? [...catalog.config].map(String).sort(byteCompare) : [],
    functionDefinitionSha256: createHash('sha256').update(definition, 'utf8').digest('hex'),
  };
}

function validateBootstrap(context: Task1CatalogBootstrapContext): void {
  if (
    context.sessionUser !== context.authority.name ||
    context.authority.commanderNamed ||
    !/^[1-9][0-9]*$/.test(context.authority.oid) ||
    context.bootstrapSuperuser.oid !== '10' ||
    !context.bootstrapSuperuser.superuser ||
    context.bootstrapSuperuser.commanderNamed
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
}

async function queryRows(client: SqlClient, sql: string): Promise<JsonRecord[]> {
  const result = await client.query(sql);
  return normalizedRows(result.rows);
}

export async function collectTask1PrebootstrapInventory(
  client: SqlClient,
  bootstrap: Task1CatalogBootstrapContext | null,
  options: { transaction?: 'managed' | 'caller' } = {},
): Promise<PrebootstrapInventoryV1> {
  let open = false;
  try {
    if (bootstrap) validateBootstrap(bootstrap);
    if (options.transaction !== 'caller') {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      open = true;
    }
    await client.query('SET LOCAL search_path = pg_catalog');
    const identityRows = await queryRows(client, TASK1_CATALOG_QUERIES.identity);
    if (identityRows.length !== 1) fail('TASK1_CATALOG_IDENTITY_INVALID');
    const identity = identityRows[0]!;
    const ledgerExists = identity.ledger_exists === true;
    const ledger = ledgerExists ? await queryRows(client, TASK1_CATALOG_QUERIES.ledger) : null;
    const namespaces = await queryRows(client, TASK1_CATALOG_QUERIES.namespaces);
    const relations = await queryRows(client, TASK1_CATALOG_QUERIES.relations);
    const functions = (await queryRows(client, TASK1_CATALOG_QUERIES.functions)).map(
      normalizeFunction,
    );
    const types = await queryRows(client, TASK1_CATALOG_QUERIES.types);
    const extensions = await queryRows(client, TASK1_CATALOG_QUERIES.extensions);
    const policies = await queryRows(client, TASK1_CATALOG_QUERIES.policies);
    const triggers = await queryRows(client, TASK1_CATALOG_QUERIES.triggers);
    const roles = await queryRows(client, TASK1_CATALOG_QUERIES.roles);
    const memberships = await queryRows(client, TASK1_CATALOG_QUERIES.memberships);
    const roleSettings = await queryRows(client, TASK1_CATALOG_QUERIES.roleSettings);
    const databaseAcl = await queryRows(client, TASK1_CATALOG_QUERIES.databaseAcl);
    const schemaAcls = await queryRows(client, TASK1_CATALOG_QUERIES.schemaAcls);
    const defaultAcls = await queryRows(client, TASK1_CATALOG_QUERIES.defaultAcls);
    const productRelations = relations.filter(
      (relation) => relation.kind === 'r' || relation.kind === 'p',
    );
    const productSources = productRelations
      .map((relation) => `${String(relation.schema)}.${String(relation.name)}`)
      .sort(byteCompare);
    const productHasRows: Array<{ relation: string; hasRows: boolean }> = [];
    for (const relation of productRelations) {
      const qualified = `${quoteIdentifier(String(relation.schema))}.${quoteIdentifier(String(relation.name))}`;
      const result = await client.query<{ has_rows: boolean }>(
        `/* task1-catalog:product-has-rows */ SELECT EXISTS (SELECT 1 FROM ${qualified} LIMIT 1) AS has_rows`,
      );
      if (result.rowCount !== 1 || typeof result.rows[0]?.has_rows !== 'boolean') {
        fail('TASK1_CATALOG_PRODUCT_SOURCE_INVALID');
      }
      productHasRows.push({
        relation: `${String(relation.schema)}.${String(relation.name)}`,
        hasRows: result.rows[0].has_rows,
      });
    }

    const inventory = {
      format: 'prebootstrap_inventory/v1' as const,
      postgresVersion: String(identity.postgres_version),
      catalogVersion: String(identity.catalog_version),
      databaseIdentity: {
        oid: String(identity.database_oid),
        name: String(identity.database_name),
      },
      ledger,
      namespaces,
      relations,
      functions,
      types,
      extensions,
      policies,
      triggers,
      productSources,
      productHasRows,
      roles,
      memberships,
      roleSettings,
      databaseAcl,
      schemaAcls,
      defaultAcls,
      bootstrapIdentities: null,
    } as PrebootstrapInventoryV1;
    const classification = classifyTask1CatalogOrigin(inventory, bootstrap);
    if (classification.kind !== 'legacy')
      inventory.bootstrapIdentities = classification.bootstrapIdentities;
    if (open) {
      await client.query('COMMIT');
      open = false;
    }
    return inventory;
  } catch {
    if (open) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the sanitized collector failure.
      }
    }
    fail('TASK1_CATALOG_COLLECTION_FAILED');
  }
}

export async function collectTask1LockedCatalogInventory(
  client: SqlClient,
  origin:
    | { classification: 'E1' | 'E2'; bootstrapIdentities: BootstrapIdentitiesV1 }
    | { classification: 'legacy'; bootstrapIdentities: null },
): Promise<PrebootstrapInventoryV1> {
  if (
    (origin.classification === 'legacy' && origin.bootstrapIdentities !== null) ||
    (origin.classification !== 'legacy' &&
      (origin.bootstrapIdentities === null ||
        origin.bootstrapIdentities.envelope !== origin.classification))
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  const inventory = await collectTask1PrebootstrapInventory(client, null, {
    transaction: 'caller',
  });
  inventory.bootstrapIdentities = origin.bootstrapIdentities;
  return inventory;
}

const OWNER = 'commander_owner';
const E1_ROLES = [
  'commander_adapter_ops',
  'commander_app',
  OWNER,
  'commander_scheduler',
  'commander_worker',
] as const;
const E2_ROLES = [
  'commander_adapter_ops',
  'commander_app',
  OWNER,
  'commander_scheduler',
  'commander_tenant_authority',
  'commander_worker',
] as const;

function expectedRole(name: string): JsonRecord {
  const owner = name === OWNER;
  const scheduler = name === 'commander_scheduler';
  return {
    name,
    superuser: false,
    inherit: owner,
    createRole: owner,
    createDatabase: false,
    canLogin: true,
    replication: false,
    bypassRls: owner || scheduler,
    connectionLimit: -1,
    validUntil: null,
    roleConfig:
      name === 'commander_app'
        ? [
            { name: 'idle_in_transaction_session_timeout', value: '10s' },
            { name: 'statement_timeout', value: '55s' },
          ]
        : [],
  };
}

function freshCatalogIsEmpty(inventory: PrebootstrapInventoryV1): boolean {
  return (
    inventory.ledger === null &&
    [
      'namespaces',
      'relations',
      'functions',
      'types',
      'extensions',
      'policies',
      'triggers',
      'productSources',
      'productHasRows',
      'roleSettings',
      'defaultAcls',
    ].every((key) => Array.isArray(inventory[key]) && (inventory[key] as unknown[]).length === 0)
  );
}

function exactRows(actual: unknown, expected: unknown): boolean {
  return canonicalBootstrapJson(actual) === canonicalBootstrapJson(expected);
}

export function classifyTask1CatalogOrigin(
  inventory: PrebootstrapInventoryV1,
  bootstrap: Task1CatalogBootstrapContext | null,
): { kind: Task1CatalogOriginKind; bootstrapIdentities: BootstrapIdentitiesV1 | null } {
  if (!freshCatalogIsEmpty(inventory)) {
    if (
      bootstrap !== null ||
      (inventory.ledger === null &&
        inventory.relations.length === 0 &&
        inventory.roles.length === 0)
    ) {
      fail('MIGRATION_LEDGER_TAMPERED');
    }
    return { kind: 'legacy', bootstrapIdentities: null };
  }
  if (!bootstrap) fail('MIGRATION_LEDGER_TAMPERED');
  validateBootstrap(bootstrap);
  const roles = [...inventory.roles].sort((left, right) =>
    byteCompare(String(left.name), String(right.name)),
  );
  const memberships = [...inventory.memberships].sort((left, right) =>
    byteCompare(String(left.role), String(right.role)),
  );
  const actualRoleNames = roles.map((role) => String(role.name));
  const envelope = exactRows(actualRoleNames, E1_ROLES)
    ? 'E1'
    : exactRows(actualRoleNames, E2_ROLES)
      ? 'E2'
      : null;
  if (!envelope) fail('MIGRATION_LEDGER_TAMPERED');
  const expectedRoles = (envelope === 'E1' ? E1_ROLES : E2_ROLES)
    .map(expectedRole)
    .sort((left, right) => byteCompare(String(left.name), String(right.name)));
  if (!exactRows(roles, expectedRoles)) fail('MIGRATION_LEDGER_TAMPERED');
  const memberRoles = (envelope === 'E1' ? E1_ROLES : E2_ROLES).filter((name) => name !== OWNER);
  const expectedMemberships = memberRoles
    .map((role) => ({
      role,
      member: OWNER,
      grantor: bootstrap.authority.name,
      adminOption: true,
      inheritOption: false,
      setOption: true,
    }))
    .sort((left, right) => byteCompare(left.role, right.role));
  if (!exactRows(memberships, expectedMemberships)) fail('MIGRATION_LEDGER_TAMPERED');
  if (
    inventory.databaseAcl.some((entry) => entry.grantee === 'PUBLIC') ||
    inventory.schemaAcls.some((entry) => entry.grantee === 'PUBLIC')
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  const bootstrapIdentities: BootstrapIdentitiesV1 = {
    format: 'bootstrap_identities/v1',
    envelope,
    authority: bootstrap.authority,
    bootstrapSuperuser: bootstrap.bootstrapSuperuser,
  };
  if (
    inventory.bootstrapIdentities !== null &&
    !exactRows(inventory.bootstrapIdentities, bootstrapIdentities)
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  return { kind: envelope, bootstrapIdentities };
}

function descriptorSet(
  stage: Task1CatalogPostconditionStage,
): Array<{ id: string; checksum: string }> {
  const base = KERNEL_TASK1_BASELINE_MIGRATIONS.map(({ id, checksum }) => ({ id, checksum }));
  if (stage === 'historical' || stage === 'hardened') return base;
  const closureCount = stage === 'lifecycle' ? 1 : stage === 'expand' ? 2 : 3;
  return [
    ...base,
    ...KERNEL_TASK1_CLOSURE_MIGRATIONS.slice(0, closureCount).map(({ id, checksum }) => ({
      id,
      checksum,
    })),
  ];
}

function manifestDescriptorSet(value: unknown): Array<{ id: string; checksum: string }> {
  if (!Array.isArray(value)) fail('MIGRATION_LEDGER_TAMPERED');
  return value.map((entry) => {
    const row = asRecord(entry, 'MIGRATION_LEDGER_TAMPERED');
    if (typeof row.id !== 'string' || typeof row.checksum !== 'string') {
      fail('MIGRATION_LEDGER_TAMPERED');
    }
    return { id: row.id, checksum: row.checksum };
  });
}

function catalogDescriptorSet(
  value: readonly { id: string; checksum: string }[],
): Array<{ id: string; checksum: string }> {
  return [...value].sort(
    (left, right) => byteCompare(left.id, right.id) || byteCompare(left.checksum, right.checksum),
  );
}

function peerDatabaseIdentity(
  binding: DatabasePeerBindingV1 | undefined,
  observed: PrebootstrapInventoryV1,
): { oid: string; name: string } {
  if (
    !binding ||
    binding.format !== 'database_peer_binding_v1' ||
    !Array.isArray(binding.roles) ||
    binding.roles.length !== TASK1_DATABASE_ROLES.length
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  const roles = [...binding.roles].sort((left, right) =>
    byteCompare(String(left.role), String(right.role)),
  );
  const expectedRoles = [...TASK1_DATABASE_ROLES].sort(byteCompare);
  if (
    !exactRows(
      roles.map(({ role }) => role),
      expectedRoles,
    )
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  const first = roles[0];
  const observedIdentity = asRecord(observed.databaseIdentity, 'MIGRATION_LEDGER_TAMPERED');
  if (
    !first ||
    !/^[1-9][0-9]*$/.test(first.databaseOid) ||
    !first.databaseName ||
    roles.some(
      ({ databaseOid, databaseName }) =>
        databaseOid !== first.databaseOid || databaseName !== first.databaseName,
    ) ||
    observedIdentity.oid !== first.databaseOid ||
    observedIdentity.name !== first.databaseName
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  return { oid: first.databaseOid, name: first.databaseName };
}

function normalizedGoldenCatalog(
  inventory: PrebootstrapInventoryV1,
  databaseIdentity: { oid: string; name: string },
): JsonRecord {
  if (
    inventory.databaseIdentity.oid !== databaseIdentity.oid ||
    inventory.databaseIdentity.name !== databaseIdentity.name
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  const databaseAcl = inventory.databaseAcl.map((entry) => {
    if (entry.objectKind !== 'database' || entry.objectIdentity !== databaseIdentity.name) {
      fail('MIGRATION_LEDGER_TAMPERED');
    }
    return { ...entry, objectIdentity: TASK1_DATABASE_IDENTITY_SENTINELS.name };
  });
  const roleSettings = inventory.roleSettings.map((entry) => {
    if (entry.database === '*') return entry;
    if (entry.database !== databaseIdentity.name) fail('MIGRATION_LEDGER_TAMPERED');
    return { ...entry, database: TASK1_DATABASE_IDENTITY_SENTINELS.name };
  });
  const { productHasRows: _productHasRows, ...catalog } = inventory;
  return {
    ...catalog,
    databaseIdentity: TASK1_DATABASE_IDENTITY_SENTINELS,
    databaseAcl,
    roleSettings,
  };
}

function instantiatedGoldenCatalog(
  value: unknown,
  classification: Task1CatalogOriginKind,
  identities: BootstrapIdentitiesV1 | null,
): JsonRecord {
  const catalog = structuredClone(asRecord(value, 'MIGRATION_LEDGER_TAMPERED'));
  if (classification === 'legacy') {
    if (identities !== null || catalog.bootstrapIdentities !== null) {
      fail('MIGRATION_LEDGER_TAMPERED');
    }
    return catalog;
  }
  if (!identities || identities.envelope !== classification) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  const placeholders = asRecord(catalog.bootstrapIdentities, 'MIGRATION_LEDGER_TAMPERED');
  const authority = asRecord(placeholders.authority, 'MIGRATION_LEDGER_TAMPERED');
  const bootstrapSuperuser = asRecord(placeholders.bootstrapSuperuser, 'MIGRATION_LEDGER_TAMPERED');
  if (
    placeholders.format !== 'bootstrap_identities/v1' ||
    placeholders.envelope !== classification ||
    authority.oid !== TASK1_BOOTSTRAP_IDENTITY_SENTINELS.authorityOid ||
    authority.name !== TASK1_BOOTSTRAP_IDENTITY_SENTINELS.authorityName ||
    authority.superuser !== identities.authority.superuser ||
    authority.commanderNamed !== identities.authority.commanderNamed ||
    bootstrapSuperuser.oid !== TASK1_BOOTSTRAP_IDENTITY_SENTINELS.bootstrapSuperuserOid ||
    bootstrapSuperuser.name !== TASK1_BOOTSTRAP_IDENTITY_SENTINELS.bootstrapSuperuserName ||
    bootstrapSuperuser.superuser !== identities.bootstrapSuperuser.superuser ||
    bootstrapSuperuser.commanderNamed !== identities.bootstrapSuperuser.commanderNamed
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  catalog.bootstrapIdentities = identities;
  if (!Array.isArray(catalog.memberships)) fail('MIGRATION_LEDGER_TAMPERED');
  catalog.memberships = catalog.memberships.map((value) => {
    const entry = asRecord(value, 'MIGRATION_LEDGER_TAMPERED');
    if (entry.grantor === TASK1_BOOTSTRAP_IDENTITY_SENTINELS.authorityName) {
      return { ...entry, grantor: identities.authority.name };
    }
    if (entry.grantor === TASK1_BOOTSTRAP_IDENTITY_SENTINELS.bootstrapSuperuserName) {
      return { ...entry, grantor: identities.bootstrapSuperuser.name };
    }
    return entry;
  });
  if (canonicalBootstrapJson(catalog).includes('task1_bootstrap_identity/v1:')) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  return catalog;
}

function catalogWithoutHardeningDelta(inventory: PrebootstrapInventoryV1): unknown {
  const { productHasRows: _productHasRows, defaultAcls: _defaultAcls, ...catalog } = inventory;
  return {
    ...catalog,
    relations: inventory.relations.map((relation) => {
      const { acl: _acl, ...definition } = relation;
      return definition;
    }),
  };
}

function assertExactLockedOrigin(
  classification: Task1CatalogOriginKind,
  identities: BootstrapIdentitiesV1 | null,
  observed: PrebootstrapInventoryV1,
): void {
  if (
    classification === 'legacy'
      ? identities !== null || observed.bootstrapIdentities !== null
      : identities === null ||
        identities.envelope !== classification ||
        !exactRows(observed.bootstrapIdentities, identities)
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  const roles = [...observed.roles].sort((left, right) =>
    byteCompare(String(left.name), String(right.name)),
  );
  const expected = E2_ROLES.map(expectedRole).sort((left, right) =>
    byteCompare(String(left.name), String(right.name)),
  );
  if (!exactRows(roles, expected)) fail('MIGRATION_LEDGER_TAMPERED');
}

function assertHardenedCatalog(observed: PrebootstrapInventoryV1): void {
  const denied = new Set<string>(TASK1_RUNTIME_GRANTEES);
  for (const relation of observed.relations) {
    const identity = `${String(relation.schema)}.${String(relation.name)}`;
    if (
      !TASK1_OWNER_ONLY_RELATIONS.includes(identity as (typeof TASK1_OWNER_ONLY_RELATIONS)[number])
    ) {
      continue;
    }
    const acl = Array.isArray(relation.acl) ? relation.acl : [];
    if (acl.some((entry) => denied.has(String(asRecord(entry).grantee)))) {
      fail('MIGRATION_LEDGER_TAMPERED');
    }
  }
  if (
    observed.defaultAcls.some(
      (entry) => ['r', 'S'].includes(String(entry.objectType)) && denied.has(String(entry.grantee)),
    )
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
}

function assertLifecycleObjects(observed: PrebootstrapInventoryV1): void {
  const relations = new Set(
    observed.relations.map((relation) => `${String(relation.schema)}.${String(relation.name)}`),
  );
  for (const relation of [
    'public.commander_tenant_cutover_state',
    'public.commander_tenant_cutover_operations',
    'public.commander_tenant_cutover_rollout_proofs',
  ]) {
    if (!relations.has(relation)) fail('MIGRATION_LEDGER_TAMPERED');
  }
  for (const relation of observed.relations.filter((entry) =>
    String(entry.name).startsWith('commander_tenant_cutover_'),
  )) {
    if (relation.owner !== OWNER) fail('MIGRATION_LEDGER_TAMPERED');
  }
  const functions = new Set(
    observed.functions.map(
      (entry) =>
        `${String(entry.schema)}.${String(entry.name)}(${String(entry.identityArguments)})`,
    ),
  );
  for (const fn of [
    'public.commander_database_identity()',
    'public.commander_runtime_configuration_identity()',
    'public.reject_tenant_cutover_operation_mutation()',
    'public.reject_tenant_cutover_rollout_proof_mutation()',
  ]) {
    if (!functions.has(fn)) fail('MIGRATION_LEDGER_TAMPERED');
  }
  for (const fn of observed.functions.filter((entry) =>
    [
      'commander_database_identity',
      'commander_runtime_configuration_identity',
      'reject_tenant_cutover_operation_mutation',
      'reject_tenant_cutover_rollout_proof_mutation',
    ].includes(String(entry.name)),
  )) {
    if (
      fn.owner !== OWNER ||
      fn.securityDefiner !== true ||
      !Array.isArray(fn.config) ||
      !fn.config.includes('search_path=pg_catalog')
    ) {
      fail('MIGRATION_LEDGER_TAMPERED');
    }
  }
  const triggers = new Set(
    observed.triggers.map((trigger) => `${String(trigger.schema)}.${String(trigger.name)}`),
  );
  for (const trigger of [
    'public.commander_tenant_cutover_operations_immutable',
    'public.commander_tenant_cutover_rollout_proofs_immutable',
  ]) {
    if (!triggers.has(trigger)) fail('MIGRATION_LEDGER_TAMPERED');
  }
}

function catalogBeforeLifecycleDescriptor(inventory: PrebootstrapInventoryV1): unknown {
  const lifecycleFunctionNames = new Set([
    'commander_database_identity',
    'commander_runtime_configuration_identity',
    'reject_tenant_cutover_operation_mutation',
    'reject_tenant_cutover_rollout_proof_mutation',
  ]);
  const withoutLifecycleLedger = catalogDescriptorSet(descriptorSet('historical'));
  const { productHasRows: _productHasRows, ...catalog } = inventory;
  return {
    ...catalog,
    ledger: withoutLifecycleLedger,
    productSources: inventory.productSources.filter(
      (identity) => !identity.startsWith('public.commander_tenant_cutover_'),
    ),
    relations: inventory.relations.filter(
      (entry) => !String(entry.name).startsWith('commander_tenant_cutover_'),
    ),
    functions: inventory.functions.filter(
      (entry) => !lifecycleFunctionNames.has(String(entry.name)),
    ),
    types: inventory.types.filter(
      (entry) => !String(entry.name).startsWith('commander_tenant_cutover_'),
    ),
    triggers: inventory.triggers.filter(
      (entry) => !String(entry.name).startsWith('commander_tenant_cutover_'),
    ),
  };
}

export function verifyTask1LockedCatalogState(input: Task1LockedCatalogStateVerification): void {
  let source: JsonRecord;
  try {
    source = asRecord(JSON.parse(input.manifestSourceJcs), 'MIGRATION_LEDGER_TAMPERED');
  } catch {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  const expectedFormat =
    input.stage === 'lifecycle'
      ? 'lifecycle_postcondition_manifest/v1'
      : `${input.stage}_baseline_manifest_source/v1`;
  const expectedDescriptors = descriptorSet(input.stage);
  const sourceDescriptors = manifestDescriptorSet(source.descriptorSet);
  const observedDescriptors = manifestDescriptorSet(input.observed.ledger);
  const branches = asRecord(source.branches, 'MIGRATION_LEDGER_TAMPERED');
  const branch = asRecord(branches[input.classification], 'MIGRATION_LEDGER_TAMPERED');
  const manifest = asRecord(branch.manifest, 'MIGRATION_LEDGER_TAMPERED');
  const expectedManifestFormat =
    input.stage === 'lifecycle'
      ? 'lifecycle_postcondition_manifest/v1'
      : `${input.stage}_baseline_manifest/v1`;
  if (
    canonicalBootstrapJson(source) !== input.manifestSourceJcs ||
    source.format !== expectedFormat ||
    branch.classification !== input.classification ||
    manifest.format !== expectedManifestFormat ||
    manifest.catalogProjection !== 'task1_semantic_catalog_projection/v1' ||
    manifest.authorityClassifierManifestSha256 !== AUTHORITY_CLASSIFIER_MANIFEST_SHA256 ||
    canonicalBootstrapJson(manifest.authorityClassifierManifest) !==
      canonicalBootstrapJson({
        sha256: AUTHORITY_CLASSIFIER_MANIFEST_SHA256,
        source: 'authorityClassifierManifest.v1.json',
      }) ||
    canonicalBootstrapJson(source.normalizationSchema) !==
      canonicalBootstrapJson(TASK1_CATALOG_NORMALIZATION_SCHEMA) ||
    canonicalBootstrapJson(source.placeholderSchema) !==
      canonicalBootstrapJson(TASK1_BOOTSTRAP_PLACEHOLDER_SCHEMA) ||
    !exactRows(sourceDescriptors, expectedDescriptors) ||
    !exactRows(observedDescriptors, catalogDescriptorSet(expectedDescriptors))
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  if (
    input.classification !== 'legacy' &&
    canonicalBootstrapJson(branch.bootstrapIdentityPlaceholders) !==
      canonicalBootstrapJson(TASK1_BOOTSTRAP_PLACEHOLDER_SCHEMA.paths)
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  const databaseIdentity = peerDatabaseIdentity(input.databasePeerBinding, input.observed);
  assertExactLockedOrigin(input.classification, input.bootstrapIdentities, input.observed);
  const expectedCatalog = instantiatedGoldenCatalog(
    manifest.catalog,
    input.classification,
    input.bootstrapIdentities,
  );
  if (
    canonicalBootstrapJson(normalizedGoldenCatalog(input.observed, databaseIdentity)) !==
    canonicalBootstrapJson(expectedCatalog)
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  if (input.stage === 'historical') return;
  if (!input.previous) fail('MIGRATION_LEDGER_TAMPERED');
  peerDatabaseIdentity(input.databasePeerBinding, input.previous);
  assertHardenedCatalog(input.observed);
  if (input.stage === 'hardened') {
    if (
      canonicalBootstrapJson(catalogWithoutHardeningDelta(input.previous)) !==
      canonicalBootstrapJson(catalogWithoutHardeningDelta(input.observed))
    ) {
      fail('MIGRATION_LEDGER_TAMPERED');
    }
    return;
  }
  assertLifecycleObjects(input.observed);
  if (
    canonicalBootstrapJson(catalogBeforeLifecycleDescriptor(input.previous)) !==
    canonicalBootstrapJson(catalogBeforeLifecycleDescriptor(input.observed))
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
}

function catalogPostconditionValue(
  stage: Task1CatalogPostconditionStage,
  classification: Task1CatalogOriginKind,
  inventory: PrebootstrapInventoryV1,
): JsonRecord {
  const { productHasRows: _mutableProductRows, ...catalog } = inventory;
  return {
    format: `${stage}_baseline_manifest/v1`,
    classification,
    descriptorSet: descriptorSet(stage),
    authorityClassifierManifestSha256: AUTHORITY_CLASSIFIER_MANIFEST_SHA256,
    authorityClassifierManifest: AUTHORITY_CLASSIFIER_MANIFEST_V1,
    catalog,
  };
}

export function exportTask1CatalogPostcondition(
  stage: Task1CatalogPostconditionStage,
  classification: Task1CatalogOriginKind,
  inventory: PrebootstrapInventoryV1,
): string {
  return canonicalBootstrapJson(catalogPostconditionValue(stage, classification, inventory));
}

export function verifyTask1CatalogPostcondition(
  expectedJcs: string,
  stage: Task1CatalogPostconditionStage,
  classification: Task1CatalogOriginKind,
  observed: PrebootstrapInventoryV1,
): void {
  let expected: unknown;
  try {
    expected = JSON.parse(expectedJcs);
  } catch {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
  if (
    canonicalBootstrapJson(expected) !== expectedJcs ||
    exportTask1CatalogPostcondition(stage, classification, observed) !== expectedJcs
  ) {
    fail('MIGRATION_LEDGER_TAMPERED');
  }
}

void COMMANDER_NAME_PREDICATE;
