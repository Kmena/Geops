-- Fail closed for installations created before tenant/binding activation evidence existed.
ALTER TABLE gps_device_installation
  ADD COLUMN activation_binding_id uuid,
  ADD COLUMN activation_tenant_id text,
  ADD CONSTRAINT gps_installation_activation_pair CHECK
    ((activation_binding_id IS NULL AND activation_tenant_id IS NULL) OR
     (activation_binding_id IS NOT NULL AND activation_tenant_id IS NOT NULL)),
  ADD CONSTRAINT gps_installation_activation_fk
    FOREIGN KEY (activation_binding_id, device_id, activation_tenant_id)
    REFERENCES mdm_binding(id, geops_device_id, customer_id);
CREATE INDEX gps_device_installation_binding ON gps_device_installation(activation_binding_id, activation_tenant_id);
