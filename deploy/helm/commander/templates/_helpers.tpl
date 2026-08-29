{{/*
Commander Helm Chart — Helpers
*/}}

{{- define "commander.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "commander.labels" -}}
app.kubernetes.io/name: {{ include "commander.fullname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "commander.selectorLabels" -}}
app.kubernetes.io/name: {{ include "commander.fullname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "commander.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{ include "commander.fullname" . }}
{{- else -}}
{{ .Values.serviceAccount.name | default "default" }}
{{- end -}}
{{- end -}}

{{- define "commander.tenantAuthorityProofReaderName" -}}
{{- $identity := printf "%s/%s" .Release.Namespace .Release.Name -}}
{{- printf "commander-proof-reader-%s" (sha256sum $identity | trunc 16) -}}
{{- end -}}

{{- define "commander.databaseUrlSecretName" -}}
{{- .Values.database.postgres.existingSecret | default (printf "%s-database" (include "commander.fullname" .)) -}}
{{- end -}}

{{/* Legacy single-key fallback — prefer role-specific helpers below. */}}
{{- define "commander.databaseUrlSecretKey" -}}
{{- .Values.database.postgres.existingSecretKey | default "url" -}}
{{- end -}}

{{- define "commander.databaseOwnerSecretKey" -}}
{{- .Values.database.postgres.ownerSecretKey | default "owner-url" -}}
{{- end -}}

{{- define "commander.databaseAppSecretKey" -}}
{{- .Values.database.postgres.appSecretKey | default "app-url" -}}
{{- end -}}

{{- define "commander.databaseTenantAuthoritySecretKey" -}}
{{- .Values.database.postgres.tenantAuthoritySecretKey | default "tenant-authority-url" -}}
{{- end -}}

{{- define "commander.databaseSchedulerSecretKey" -}}
{{- .Values.database.postgres.schedulerSecretKey | default "scheduler-url" -}}
{{- end -}}

{{- define "commander.databaseWorkerSecretKey" -}}
{{- .Values.database.postgres.workerSecretKey | default "worker-url" -}}
{{- end -}}

{{- define "commander.databaseAdapterOpsSecretKey" -}}
{{- .Values.database.postgres.adapterOpsSecretKey | default "adapter-ops-url" -}}
{{- end -}}

{{- define "commander.bundledPostgres" -}}
{{- if and .Values.database.enabled (eq .Values.database.backend "postgres") .Values.database.postgres.bundled -}}true{{- end -}}
{{- end -}}

{{- define "commander.databaseTlsCaSecretName" -}}
{{- if include "commander.bundledPostgres" . -}}
{{- .Values.databaseTls.existingSecret -}}
{{- else -}}
{{- .Values.databaseTls.caSecret -}}
{{- end -}}
{{- end -}}

{{- define "commander.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end -}}

{{- define "commander.requireLifecycleValues" -}}
{{- if include "commander.postgresBackend" . -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" (.Values.image.digest | default "")) -}}{{- fail "tenant authority PostgreSQL lifecycle requires image.digest=sha256:<64 lower hex>" -}}{{- end -}}
{{- if not (regexMatch "^[0-9a-f]{64}$" (.Values.tenantAuthority.configurationSha256 | default "")) -}}{{- fail "tenant authority lifecycle requires tenantAuthority.configurationSha256" -}}{{- end -}}
{{- if not (regexMatch "^[0-9a-f]{64}$" (.Values.databaseTls.expectedServerSpkiSha256 | default "")) -}}{{- fail "tenant authority PostgreSQL lifecycle requires databaseTls.expectedServerSpkiSha256" -}}{{- end -}}
{{- if and (include "commander.bundledPostgres" .) (not .Values.databaseTls.existingSecret) -}}{{- fail "bundled PostgreSQL requires databaseTls.existingSecret" -}}{{- end -}}
{{- if and (include "commander.bundledPostgres" .) .Values.databaseTls.caSecret -}}{{- fail "bundled PostgreSQL forbids databaseTls.caSecret" -}}{{- end -}}
{{- if and (not (include "commander.bundledPostgres" .)) (not .Values.databaseTls.caSecret) -}}{{- fail "external PostgreSQL requires databaseTls.caSecret" -}}{{- end -}}
{{- if and (not (include "commander.bundledPostgres" .)) .Values.databaseTls.existingSecret -}}{{- fail "external PostgreSQL forbids databaseTls.existingSecret" -}}{{- end -}}
{{- if and .Release.IsInstall (not (include "commander.bundledPostgres" .)) (not .Values.tenantAuthority.bootstrapAuthoritySecret) -}}{{- fail "fresh external PostgreSQL requires tenantAuthority.bootstrapAuthoritySecret" -}}{{- end -}}
{{- if not .Values.tenantAuthority.apiProof.privateSecret -}}{{- fail "tenant authority PostgreSQL lifecycle requires tenantAuthority.apiProof.privateSecret" -}}{{- end -}}
{{- if and .Values.networkPolicy.enabled (not (include "commander.bundledPostgres" .)) (eq (len .Values.networkPolicy.egress.databaseCidrs) 0) -}}{{- fail "external PostgreSQL lifecycle with networkPolicy.enabled requires networkPolicy.egress.databaseCidrs" -}}{{- end -}}
{{- if and (include "commander.bundledPostgres" .) .Values.database.postgres.persistence.enabled (not .Values.database.postgres.existingSecret) -}}{{- fail "persistent bundled PostgreSQL requires database.postgres.existingSecret" -}}{{- end -}}
{{- end -}}
{{- end -}}

{{- define "commander.requireTransportBootstrapValues" -}}
{{- if .Values.tenantAuthority.transportBootstrap -}}
{{- if not (include "commander.bundledPostgres" .) -}}{{- fail "tenantAuthority.transportBootstrap requires bundled PostgreSQL" -}}{{- end -}}
{{- if not .Values.database.postgres.existingSecret -}}{{- fail "tenantAuthority.transportBootstrap requires database.postgres.existingSecret" -}}{{- end -}}
{{- end -}}
{{- end -}}

{{- define "commander.migrationJobName" -}}
{{- $suffix := printf "-migration-r%d" .Release.Revision -}}
{{- $base := include "commander.fullname" . | trunc (int (sub 63 (len $suffix))) | trimSuffix "-" -}}
{{- printf "%s%s" $base $suffix -}}
{{- end -}}

{{- define "commander.tenantCutoverProofJobName" -}}
{{- $suffix := printf "-tenant-cutover-prove-r%d" .Release.Revision -}}
{{- $base := include "commander.fullname" . | trunc (int (sub 63 (len $suffix))) | trimSuffix "-" -}}
{{- printf "%s%s" $base $suffix -}}
{{- end -}}

{{- define "commander.proofReaderLabels" -}}
app.kubernetes.io/name: {{ include "commander.fullname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: tenant-authority-proof-reader
commander.io/tenant-authority-proof-reader: "true"
commander.io/tenant-authority-proof-release: {{ .Release.Name | quote }}
{{- end -}}

{{- define "commander.migrationHook" -}}
{{- if not (and .Release.IsInstall (include "commander.bundledPostgres" .)) -}}pre-install,pre-upgrade,pre-rollback{{- end -}}
{{- end -}}

{{- define "commander.runtimeMigrationGate" -}}
{{- $root := index . "root" -}}
{{- $key := index . "key" -}}
- name: migration-gate
  image: {{ include "commander.image" $root | quote }}
  imagePullPolicy: {{ $root.Values.image.pullPolicy }}
  command: ["node", "packages/kernel/dist/migrationGate.js", "await"]
  env:
    - name: COMMANDER_KERNEL_DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: {{ include "commander.databaseUrlSecretName" $root | quote }}
          key: {{ $key | quote }}
    - name: COMMANDER_MIGRATION_EXPECTED_DESCRIPTORS
      value: {{ $root.Values.tenantAuthority.expectedMigrationDescriptors | quote }}
    {{- include "commander.databaseTlsEnv" $root | nindent 4 }}
  securityContext:
    {{- include "commander.cellSecurityContext" $root | nindent 4 }}
  volumeMounts:
    {{- include "commander.databaseTlsVolumeMount" $root | nindent 4 }}
{{- end -}}

{{- define "commander.databaseTlsEnv" -}}
- name: COMMANDER_DATABASE_TLS_CA_FILE
  value: /run/commander/database-tls/ca.crt
- name: COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256
  value: {{ .Values.databaseTls.expectedServerSpkiSha256 | quote }}
{{- end -}}

{{- define "commander.databaseTlsVolumeMount" -}}
- name: database-public-ca
  mountPath: /run/commander/database-tls
  readOnly: true
{{- end -}}

{{- define "commander.databaseTlsVolume" -}}
- name: database-public-ca
  secret:
    secretName: {{ include "commander.databaseTlsCaSecretName" . | quote }}
    items:
      - key: {{ .Values.databaseTls.caKey | quote }}
        path: ca.crt
{{- end -}}

{{- define "commander.postgresBackend" -}}
{{- if and .Values.database.enabled (eq .Values.database.backend "postgres") -}}true{{- end -}}
{{- end -}}

{{- define "commander.apiStoreBackend" -}}
{{- if include "commander.postgresBackend" . -}}memory{{- else -}}{{ .Values.database.backend }}{{- end -}}
{{- end -}}

{{- define "commander.requireEnterpriseSecrets" -}}
{{- if eq .Values.tier "enterprise" -}}
{{- if not .Values.database.postgres.existingSecret -}}{{- fail "enterprise tier requires database.postgres.existingSecret" -}}{{- end -}}
{{- if and (not .Values.api.secrets.existingSecret) (or (not .Values.api.secrets.masterKeySecret) (not .Values.api.secrets.jwtSecretSecret) (not .Values.api.secrets.apiKeySecret)) -}}{{- fail "enterprise tier requires api.secrets.existingSecret or all API secret refs" -}}{{- end -}}
{{- if not .Values.worker.authTokenSecret -}}{{- fail "enterprise tier requires worker.authTokenSecret" -}}{{- end -}}
{{- if not .Values.adapterOps.secrets.existingSecret -}}{{- fail "enterprise tier requires adapterOps.secrets.existingSecret" -}}{{- end -}}
{{- if not .Values.capability.existingSecret -}}{{- fail "enterprise tier requires capability.existingSecret" -}}{{- end -}}
{{- if .Values.capability.create -}}{{- fail "enterprise tier forbids capability.create (existingSecret refs only; no generated-key path)" -}}{{- end -}}
{{- if not .Values.evidenceSigning.existingSecret -}}{{- fail "enterprise tier requires evidenceSigning.existingSecret" -}}{{- end -}}
{{- if .Values.evidenceSigning.create -}}{{- fail "enterprise tier forbids evidenceSigning.create (existingSecret refs only; no generated-key path)" -}}{{- end -}}
{{- if .Values.database.postgres.bundled -}}{{- fail "enterprise tier requires database.postgres.bundled=false" -}}{{- end -}}
{{- if not .Values.worker.enabled -}}{{- fail "enterprise tier requires worker.enabled=true" -}}{{- end -}}
{{- if not .Values.kernelOps.enabled -}}{{- fail "enterprise tier requires kernelOps.enabled=true" -}}{{- end -}}
{{- if not .Values.adapterOps.enabled -}}{{- fail "enterprise tier requires adapterOps.enabled=true" -}}{{- end -}}
{{- if eq (len .Values.adapterOps.egress.allowlist) 0 -}}{{- fail "enterprise tier requires adapterOps.egress.allowlist with at least one explicit hostname" -}}{{- end -}}
{{- $tenants := .Values.worker.tenants | toString | trim -}}
{{- if or (eq $tenants "") (eq $tenants "*") -}}
{{- fail "enterprise tier requires worker.tenants as an explicit non-wildcard list (operator-supplied)" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "commander.apiSecretName" -}}
{{- .Values.api.secrets.existingSecret | default (printf "%s-api-secrets" (include "commander.fullname" .)) -}}
{{- end -}}

{{- define "commander.workerTokenSecretName" -}}
{{- .Values.worker.authTokenSecret | default (printf "%s-worker-token" (include "commander.fullname" .)) -}}
{{- end -}}

{{- define "commander.capabilitySecretName" -}}
{{- .Values.capability.existingSecret | default (printf "%s-capability" (include "commander.fullname" .)) -}}
{{- end -}}

{{- define "commander.capabilityPrivateKeyPemKey" -}}
{{- .Values.capability.privateKeyPemKey | default "private-key-pem" -}}
{{- end -}}

{{- define "commander.capabilityKeyIdKey" -}}
{{- .Values.capability.keyIdKey | default "key-id" -}}
{{- end -}}

{{- define "commander.capabilityJwksJsonKey" -}}
{{- .Values.capability.jwksJsonKey | default "jwks-json" -}}
{{- end -}}

{{- define "commander.evidenceSigningSecretName" -}}
{{- .Values.evidenceSigning.existingSecret | default (printf "%s-evidence-signing" (include "commander.fullname" .)) -}}
{{- end -}}

{{- define "commander.evidenceSigningPrivateKeyPemKey" -}}
{{- .Values.evidenceSigning.privateKeyPemKey | default "private-key-pem" -}}
{{- end -}}

{{- define "commander.evidenceSigningKeyIdKey" -}}
{{- .Values.evidenceSigning.keyIdKey | default "key-id" -}}
{{- end -}}

{{- define "commander.evidenceSigningJwksJsonKey" -}}
{{- .Values.evidenceSigning.jwksJsonKey | default "jwks-json" -}}
{{- end -}}

{{/* Mount Ed25519 authority env from Secret refs only (never inline PEM/JWKS). */}}
{{- define "commander.capabilityEnv" -}}
- name: COMMANDER_CAPABILITY_PRIVATE_KEY_PEM
  valueFrom:
    secretKeyRef:
      name: {{ include "commander.capabilitySecretName" . | quote }}
      key: {{ include "commander.capabilityPrivateKeyPemKey" . | quote }}
- name: COMMANDER_CAPABILITY_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "commander.capabilitySecretName" . | quote }}
      key: {{ include "commander.capabilityKeyIdKey" . | quote }}
- name: COMMANDER_CAPABILITY_JWKS_JSON
  valueFrom:
    secretKeyRef:
      name: {{ include "commander.capabilitySecretName" . | quote }}
      key: {{ include "commander.capabilityJwksJsonKey" . | quote }}
{{- end -}}

{{/* Only effect-writing runtimes receive the evidence private key. */}}
{{- define "commander.evidenceSigningEnv" -}}
- name: COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM
  valueFrom:
    secretKeyRef:
      name: {{ include "commander.evidenceSigningSecretName" . | quote }}
      key: {{ include "commander.evidenceSigningPrivateKeyPemKey" . | quote }}
- name: COMMANDER_EVIDENCE_SIGNING_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "commander.evidenceSigningSecretName" . | quote }}
      key: {{ include "commander.evidenceSigningKeyIdKey" . | quote }}
{{- end -}}

{{/* Runtime profile / cell tier — enterprise forces fail-closed authority paths. */}}
{{- define "commander.profileTierEnv" -}}
- name: COMMANDER_CELL_TIER
  value: {{ .Values.tier | quote }}
{{- if eq (.Values.tier | toString) "enterprise" }}
- name: COMMANDER_PROFILE
  value: "enterprise"
{{- end }}

{{- end -}}

{{/*
Cell tenant for EnvAdapterCredentialProvider / COMMANDER_CELL_TENANT_ID.
Prefer explicit cell.tenantId; else first entry of worker.tenants (comma-separated).
Never silent empty — fail at template time so enterprise cannot fall back to "local".
*/}}
{{- define "commander.cellTenantId" -}}
{{- if and .Values.cell .Values.cell.tenantId -}}
{{- .Values.cell.tenantId | toString | trim -}}
{{- else -}}
{{- $tenants := .Values.worker.tenants | toString | trim -}}
{{- $first := index (splitList "," $tenants) 0 | trim -}}
{{- if eq $first "" -}}
{{- fail "COMMANDER_CELL_TENANT_ID requires cell.tenantId or a non-empty worker.tenants first entry" -}}
{{- end -}}
{{- $first -}}
{{- end -}}
{{- end -}}

{{- define "commander.cellSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop:
    - ALL
{{- end -}}
