import type { ReactNode } from 'react';

/** The Staging 1 bundle omits MDM controls unless explicitly built for a later stage. */
export const mdmEnabled = import.meta.env?.VITE_MDM_ENABLED === 'true';

export function MdmOnly({
  children,
  enabled = mdmEnabled,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  return enabled ? children : null;
}
