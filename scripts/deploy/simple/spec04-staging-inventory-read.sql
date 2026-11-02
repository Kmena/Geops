-- Read-only SPEC-04 staging inventory. Run with a staging read-only database role.
-- Review every ID and its identity traits; never select a device by row count.
BEGIN READ ONLY;
SELECT d.id AS device_id, d.display_label, d.status,
       b.provider, b.customer_id, b.mdm_device_id, b.state AS binding_state,
       t.tenant_id AS geops_tenant_id,
       EXISTS (SELECT 1 FROM gps_device_installation i
               WHERE i.device_id=d.id AND i.retired_at IS NULL) AS gps_installed,
       EXISTS (SELECT 1 FROM gps_mdm_continuous_authorization c
               WHERE c.device_id=d.id AND c.revoked_at IS NULL) AS continuous_authorized,
       (SELECT count(*) FROM device_key k
        WHERE k.geops_device_id=d.id AND k.status='ACTIVE') AS active_keys,
       (SELECT count(*) FROM device_session s
        WHERE s.geops_device_id=d.id AND s.revoked_at IS NULL
          AND s.expires_at>now()) AS live_sessions,
       (SELECT count(*) FROM gps_policy_delivery p
        WHERE p.device_id=d.id AND p.offline_not_after>now()
          AND (p.authorized_until IS NULL OR p.authorized_until>now()))
         AS offline_possible,
       (SELECT max(p.offline_not_after) FROM gps_policy_delivery p
        WHERE p.device_id=d.id AND p.offline_not_after>now()
          AND (p.authorized_until IS NULL OR p.authorized_until>now()))
         AS offline_not_after,
       (SELECT count(*) FROM position_event p WHERE p.device_id=d.id)
         AS historical_positions,
       (SELECT count(*) FROM gps_effective_session s WHERE s.device_id=d.id)
         AS historical_sessions,
       (SELECT count(*) FROM agent_device_link l WHERE l.device_id=d.id)
         AS historical_agent_links,
       (SELECT count(*) FROM audit_event a WHERE a.device_id=d.id)
         AS audit_events
FROM geops_device d
LEFT JOIN LATERAL (
  SELECT provider,customer_id,mdm_device_id,state FROM mdm_binding
  WHERE geops_device_id=d.id
  ORDER BY CASE state WHEN 'ACTIVE' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END,
           version DESC,id DESC LIMIT 1
) b ON true
LEFT JOIN geops_device_tenant t ON t.device_id=d.id
ORDER BY d.created_at,d.id;
COMMIT;
