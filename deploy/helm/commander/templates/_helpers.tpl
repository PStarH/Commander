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

{{- define "commander.databaseUrlSecretKey" -}}
{{- .Values.database.postgres.existingSecretKey | default "url" -}}
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
{{- if .Values.database.postgres.bundled -}}{{- fail "enterprise tier requires database.postgres.bundled=false" -}}{{- end -}}
{{- if not .Values.worker.enabled -}}{{- fail "enterprise tier requires worker.enabled=true" -}}{{- end -}}
{{- if not .Values.kernelOps.enabled -}}{{- fail "enterprise tier requires kernelOps.enabled=true" -}}{{- end -}}
{{- if not .Values.adapterOps.enabled -}}{{- fail "enterprise tier requires adapterOps.enabled=true" -}}{{- end -}}
{{- end -}}
{{- end -}}

{{- define "commander.apiSecretName" -}}
{{- .Values.api.secrets.existingSecret | default (printf "%s-api-secrets" (include "commander.fullname" .)) -}}
{{- end -}}

{{- define "commander.workerTokenSecretName" -}}
{{- .Values.worker.authTokenSecret | default (printf "%s-worker-token" (include "commander.fullname" .)) -}}
{{- end -}}

{{- define "commander.cellSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop:
    - ALL
{{- end -}}
