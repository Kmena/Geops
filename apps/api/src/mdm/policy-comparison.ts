import type { DiagnosticSnapshot } from '../device-diagnostics-contract.js';
import type { MdmDevicePolicyRead } from './policy-read.js';

export type MdmFindingClass = 'CONFIRMED' | 'POSSIBLE' | 'INSUFFICIENT_EVIDENCE' | 'STALE';
export interface MdmFinding {
  code: string;
  classification: MdmFindingClass;
  source: 'MANAGEENGINE' | 'ANDROID' | 'SERVER';
}
export interface MdmDesired {
  profile_id?: string;
  app_version?: string;
}

/** Assigned, vendor-reported applied and Android-effective are separate evidence levels. */
export function compareMdm(
  link: 'MISSING' | 'INVALID' | 'VALID',
  mdm: MdmDevicePolicyRead | null,
  local: { payload: DiagnosticSnapshot; received_at: string } | null,
  desired: MdmDesired,
  now = new Date(),
): MdmFinding[] {
  const out: MdmFinding[] = [];
  const add = (code: string, classification: MdmFindingClass, source: MdmFinding['source']) =>
    out.push({ code, classification, source });
  if (link === 'MISSING') add('MDM_DEVICE_NOT_LINKED', 'CONFIRMED', 'SERVER');
  if (link === 'INVALID') add('MDM_DEVICE_ID_INVALID', 'CONFIRMED', 'SERVER');
  if (link !== 'VALID') return out;
  if (!mdm) {
    add('MDM_DIAGNOSTIC_STALE', 'INSUFFICIENT_EVIDENCE', 'SERVER');
    add('MDM_PROFILE_APPLICATION_UNKNOWN', 'INSUFFICIENT_EVIDENCE', 'MANAGEENGINE');
    return out;
  }
  const mdmAge = now.getTime() - Date.parse(mdm.fetched_at);
  if (!Number.isFinite(mdmAge) || mdmAge > 15 * 60_000)
    add('MDM_DIAGNOSTIC_STALE', 'STALE', 'SERVER');
  const contact = mdm.device.last_contact_at ? Date.parse(mdm.device.last_contact_at) : NaN;
  if (Number.isFinite(contact) && now.getTime() - contact > 24 * 60 * 60_000)
    add('MDM_DEVICE_OFFLINE', 'POSSIBLE', 'MANAGEENGINE');
  if (mdm.profiles.state === 'NOT_SUPPORTED' || mdm.apps.state === 'NOT_SUPPORTED')
    add('MDM_CAPABILITY_NOT_SUPPORTED', 'CONFIRMED', 'MANAGEENGINE');
  if (desired.profile_id && mdm.profiles.state === 'AVAILABLE') {
    const profile = mdm.profiles.items.find((p) => p.profile_id === desired.profile_id);
    if (!profile) add('MDM_PROFILE_NOT_ASSIGNED', 'CONFIRMED', 'MANAGEENGINE');
    else if (profile.distribution === 'PENDING')
      add('MDM_PROFILE_PENDING', 'CONFIRMED', 'MANAGEENGINE');
    else if (profile.distribution !== 'APPLIED_REPORTED')
      add('MDM_PROFILE_APPLICATION_UNKNOWN', 'INSUFFICIENT_EVIDENCE', 'MANAGEENGINE');
  } else if (mdm.profiles.state !== 'AVAILABLE') {
    add('MDM_PROFILE_APPLICATION_UNKNOWN', 'INSUFFICIENT_EVIDENCE', 'MANAGEENGINE');
  }
  const effectiveAge = local ? now.getTime() - Date.parse(local.received_at) : Infinity;
  if (effectiveAge > 15 * 60_000 || effectiveAge < -5 * 60_000)
    add('MDM_DIAGNOSTIC_STALE', 'STALE', 'ANDROID');
  const effective = local?.payload.permissions;
  const appliedProfile = mdm.profiles.items.find(
    (p) => p.distribution === 'APPLIED_REPORTED' && p.configured_global_permission === 'AUTO_GRANT',
  );
  if (
    effective &&
    effectiveAge <= 15 * 60_000 &&
    appliedProfile &&
    (effective.fine === 'DENIED' || effective.background === 'DENIED')
  )
    add('MDM_PERMISSION_MISMATCH', 'POSSIBLE', 'SERVER');
  const app = mdm.apps.items.find((a) => a.package_name === 'com.geops.corporate');
  if (
    desired.app_version &&
    app?.installed_reported &&
    app.version_name &&
    app.version_name !== desired.app_version
  )
    add('MDM_CONFIGURATION_MISMATCH', 'POSSIBLE', 'MANAGEENGINE');
  if (
    local &&
    app?.installed_reported &&
    app.version_name &&
    effectiveAge <= 15 * 60_000 &&
    app.version_name !== local.payload.app_version
  )
    add('MDM_APP_VERSION_MISMATCH', 'POSSIBLE', 'SERVER');
  return [...new Map(out.map((f) => [`${f.code}:${f.source}`, f])).values()];
}
