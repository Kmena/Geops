const PREFIX = /^\s*(?:\(([0-9]{1,20})\)|([0-9]{1,20}))\s*[-:]\s*(\S(?:.*\S)?)\s*$/u;

export function splitNameCode(
  rawName: unknown,
  explicitCode: unknown,
): {
  name: string | null;
  code: string | null;
  codeSource: 'EXTENDED_DATA' | 'NAME_PREFIX' | null;
} {
  const name = typeof rawName === 'string' ? rawName.normalize('NFC').trim() : null;
  const provided = typeof explicitCode === 'string' ? explicitCode.trim() : '';
  const prefix = name ? PREFIX.exec(name) : null;
  const digits = prefix?.[1] ?? prefix?.[2];
  const inferred = digits?.replace(/^0+(?=\d)/u, '') ?? null;
  return {
    name: prefix?.[3] ?? name,
    code: provided || inferred,
    codeSource: provided ? 'EXTENDED_DATA' : inferred ? 'NAME_PREFIX' : null,
  };
}
