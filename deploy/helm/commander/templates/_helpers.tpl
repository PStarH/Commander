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
