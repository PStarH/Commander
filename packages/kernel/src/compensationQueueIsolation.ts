export const KERNEL_COMPENSATION_QUEUE_ISOLATION_SQL = String.raw`
CREATE FUNCTION public.enforce_compensation_queue_isolation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  UPDATE public.commander_steps
     SET kind = 'effect.compensate'
   WHERE id = NEW.compensation_step_id
     AND tenant_id = NEW.tenant_id
     AND kind = 'tool'
     AND state IN ('PENDING','RETRY_WAIT');
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_compensation_queue_isolation() OWNER TO commander_owner;
REVOKE ALL ON FUNCTION public.enforce_compensation_queue_isolation() FROM PUBLIC;

CREATE TRIGGER commander_compensation_queue_isolation
AFTER INSERT OR UPDATE OF compensation_step_id, tenant_id
ON public.commander_compensation_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_compensation_queue_isolation();

UPDATE public.commander_steps AS step
   SET kind = 'effect.compensate'
  FROM public.commander_compensation_requests AS request
 WHERE step.id = request.compensation_step_id
   AND step.tenant_id = request.tenant_id
   AND step.kind = 'tool'
   AND step.state IN ('PENDING','RETRY_WAIT');

WITH released AS (
  UPDATE public.commander_steps AS step
     SET kind = 'effect.compensate',
         state = 'RETRY_WAIT',
         lease_worker_id = NULL,
         lease_worker_generation = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         scheduled_at = clock_timestamp(),
         updated_at = clock_timestamp()
    FROM public.commander_compensation_requests AS request
   WHERE step.id = request.compensation_step_id
     AND step.tenant_id = request.tenant_id
     AND step.kind = 'tool'
     AND step.state = 'RUNNING'
  RETURNING step.tenant_id
), released_by_tenant AS (
  SELECT tenant_id, count(*)::integer AS released_count
    FROM released
   GROUP BY tenant_id
)
UPDATE public.commander_tenant_execution_usage AS usage
   SET running_steps = GREATEST(0, usage.running_steps - released.released_count),
       updated_at = clock_timestamp()
  FROM released_by_tenant AS released
 WHERE usage.tenant_id = released.tenant_id;
`;
