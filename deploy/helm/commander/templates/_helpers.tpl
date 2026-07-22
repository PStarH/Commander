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

{{- define "commander.databaseSchedulerSecretKey" -}}
{{- .Values.database.postgres.schedulerSecretKey | default "scheduler-url" -}}
{{- end -}}

{{- define "commander.databaseWorkerSecretKey" -}}
{{- .Values.database.postgres.workerSecretKey | default "worker-url" -}}
{{- end -}}

{{- define "commander.bundledPostgres" -}}
{{- if and .Values.database.enabled (eq .Values.database.backend "postgres") .Values.database.postgres.bundled -}}true{{- end -}}
{{- end -}}

{{- define "commander.postgresBackend" -}}
{{- if and .Values.database.enabled (eq .Values.database.backend "postgres") -}}true{{- end -}}
{{- end -}}

{{- define "commander.requireEnterpriseSecrets" -}}
{{- if eq .Values.tier "enterprise" -}}
{{- if not .Values.database.postgres.existingSecret -}}{{- fail "enterprise tier requires database.postgres.existingSecret" -}}{{- end -}}
{{- if and (not .Values.api.secrets.existingSecret) (or (not .Values.api.secrets.masterKeySecret) (not .Values.api.secrets.jwtSecretSecret) (not .Values.api.secrets.apiKeySecret)) -}}{{- fail "enterprise tier requires api.secrets.existingSecret or all API secret refs" -}}{{- end -}}
{{- if not .Values.worker.authTokenSecret -}}{{- fail "enterprise tier requires worker.authTokenSecret" -}}{{- end -}}
{{- if not .Values.adapterOps.secrets.existingSecret -}}{{- fail "enterprise tier requires adapterOps.secrets.existingSecret" -}}{{- end -}}
{{- if not .Values.capability.existingSecret -}}{{- fail "enterprise tier requires capability.existingSecret" -}}{{- end -}}
{{- if .Values.capability.create -}}{{- fail "enterprise tier forbids capability.create (existingSecret refs only; no generated-key path)" -}}{{- end -}}
{{- if .Values.database.postgres.bundled -}}{{- fail "enterprise tier requires database.postgres.bundled=false" -}}{{- end -}}
{{- if not .Values.worker.enabled -}}{{- fail "enterprise tier requires worker.enabled=true" -}}{{- end -}}
{{- if not .Values.kernelOps.enabled -}}{{- fail "enterprise tier requires kernelOps.enabled=true" -}}{{- end -}}
{{- if not .Values.adapterOps.enabled -}}{{- fail "enterprise tier requires adapterOps.enabled=true" -}}{{- end -}}
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
