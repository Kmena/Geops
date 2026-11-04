import type { Action, Candidate, ReviewRow } from './api.js';

export function decisionOptions(
  record: Pick<ReviewRow, 'record_type' | 'source_kind' | 'review_state'>,
): Array<[Action, string]> {
  const customerPoint = ['CLIENT_CANDIDATE', 'REFERENCE_POINT', 'WEEKLY_STOP'].includes(
    record.record_type,
  );
  if (!customerPoint || record.review_state === 'INVALID')
    return [
      ['EXCLUDE', customerPoint ? 'Rechazar punto' : 'Excluir elemento'],
      ['PENDING', 'Decidir después'],
    ];
  return [
    ...(record.source_kind === 'WEEKLY_STOP'
      ? []
      : [['CREATE', 'Cliente nuevo'] as [Action, string]]),
    ['LINK', 'Vincular cliente'],
    ['UPDATE', 'Actualizar cliente'],
    ['EXCLUDE', 'Rechazar punto'],
    ['PENDING', 'Decidir después'],
  ];
}

const findings: Record<string, { title: string; next: string }> = {
  CODE_NAME_LOCATION_CONFLICT: {
    title: 'El código coincide, pero el nombre o la ubicación difieren',
    next: 'Compara los registros indicados abajo y confirma manualmente si pertenecen al mismo cliente.',
  },
  IDENTITY_NAME_CONFLICT: {
    title: 'El identificador GEOPS apunta a un nombre distinto',
    next: 'Verifica el cliente existente antes de vincular o actualizar.',
  },
  IDENTITY_LOCATION_CONFLICT: {
    title: 'El identificador GEOPS apunta a otra ubicación',
    next: 'Revisa la sede y sus coordenadas antes de decidir.',
  },
  INCONSISTENT_GEOPS_REFERENCE: {
    title: 'La referencia GEOPS del KMZ no coincide con el catálogo',
    next: 'Corrige el archivo de origen y crea otra revisión, o excluye este registro.',
  },
  MULTIPLE_CUSTOMER_CANDIDATES: {
    title: 'Hay más de un cliente existente que podría coincidir',
    next: 'Compara las opciones y selecciona explícitamente el cliente correcto.',
  },
  DUPLICATE_CODE: {
    title: 'Código repetido dentro del KMZ',
    next: 'Abre el otro registro indicado abajo y decide cuál conservar, corregir o excluir.',
  },
  COORDINATE_COLLISION: {
    title: 'Dos puntos comparten exactamente las coordenadas',
    next: 'Comprueba si representan la misma sede antes de aprobarlos.',
  },
  HEREDIA_COPY_SUSPECT: {
    title: 'Posible copia de un punto de Heredia',
    next: 'Compara nombre, código y ubicación con el otro registro del KMZ.',
  },
  CANDIDATE_LIMIT: {
    title: 'Hay más coincidencias que las mostradas',
    next: 'Busca también en el catálogo antes de tomar una decisión.',
  },
  INVALID_TOPOLOGY: {
    title: 'La geometría del polígono no es válida',
    next: 'Corrige el polígono en el KMZ y carga una nueva revisión, o excluye este registro.',
  },
  INVALID_POLYGON: {
    title: 'El polígono está incompleto o no cierra',
    next: 'Corrige la geometría en el KMZ y carga una nueva revisión, o excluye este registro.',
  },
  INVALID_GEOMETRY: {
    title: 'Falta geometría válida',
    next: 'Corrige el elemento en el KMZ y carga una nueva revisión, o exclúyelo.',
  },
  INVALID_POINT: {
    title: 'El punto contiene más de una posición',
    next: 'Corrige el punto en el KMZ y carga una nueva revisión, o exclúyelo.',
  },
  INVALID_COORDINATE: {
    title: 'Las coordenadas no son válidas',
    next: 'Corrige el punto en el KMZ y carga una nueva revisión, o exclúyelo.',
  },
  INVALID_LINE: {
    title: 'La línea necesita al menos dos posiciones',
    next: 'Corrige el trazado en el KMZ y carga una nueva revisión, o exclúyelo.',
  },
  OUT_OF_AREA: {
    title: 'El punto está fuera del área esperada',
    next: 'Comprueba las coordenadas antes de aprobar el registro.',
  },
  NO_GEOMETRY: {
    title: 'El elemento no tiene geometría',
    next: 'Añade la ubicación al KMZ o excluye el registro si no corresponde.',
  },
  NO_LOCATION: {
    title: 'No se pudo identificar una ubicación',
    next: 'Revisa el elemento de origen antes de decidir.',
  },
  UNLINKED_STOP: {
    title: 'Parada semanal sin cliente vinculado',
    next: 'Identifica el cliente existente antes de vincular esta parada.',
  },
  MULTI_GEOMETRY: {
    title: 'El elemento contiene varias geometrías',
    next: 'Revisa todas las formas antes de decidir si lo conservarás.',
  },
};

export function finding(code: string): { title: string; next: string } {
  return (
    findings[code] ?? {
      title: `Hallazgo del análisis: ${code.replaceAll('_', ' ').toLowerCase()}`,
      next: 'Revisa el registro de origen y sus coincidencias antes de decidir.',
    }
  );
}

export function firstFinding(row: ReviewRow): string | null {
  const code = row.parse_errors?.[0] ?? row.conflicts[0] ?? row.warnings[0];
  if (code) return finding(code).title;
  if (row.review_state === 'INVALID') return 'Elemento sin tipo o geometría reconocible';
  if (row.review_state === 'POSSIBLE_DUPLICATE') {
    const count = row.evidence?.candidate_count;
    return count
      ? `${count} coincidencia(s) para comparar`
      : 'Abre las coincidencias para comparar';
  }
  return null;
}

const signals: Record<string, string> = {
  IN_FILE_CODE: 'Mismo código en este KMZ',
  IN_FILE_NAME: 'Mismo nombre en este KMZ',
  IN_FILE_SIMILAR_NAME: 'Nombre parecido en este KMZ',
  IN_FILE_PROXIMITY: 'Puntos cercanos en este KMZ',
  SAME_PARENT_GROUP: 'Misma ruta o agrupación',
  SAME_WEEK: 'Misma semana',
  PROXIMITY_HIGH: 'A menos de 50 m',
  PROXIMITY_EXTENDED: 'A menos de 250 m',
  NAME_NORMALIZED_EXACT: 'Nombre igual al normalizarlo',
  NAME_SIMILAR: 'Nombre parecido',
  SOURCE_KEY_EXACT_NON_AUTHORITATIVE: 'Mismo código de referencia',
  LINKED_CUSTOMER: 'Cliente asociado a la sede',
  CUSTOMER_NAME: 'Nombre igual al de un cliente',
  ESTABLISHMENT_NAME: 'Nombre igual al de una sede',
  ESTABLISHMENT_SPATIAL: 'Cerca de una sede',
  ESTABLISHMENT_SOURCE_KEY: 'Mismo código de referencia de una sede',
  PIN_SPATIAL: 'Cerca de una geozona',
  EXPLICIT_GEOPS_CUSTOMER_ID: 'Identificador GEOPS de cliente en el archivo',
  EXPLICIT_GEOPS_ESTABLISHMENT_ID: 'Identificador GEOPS de sede en el archivo',
  EXPLICIT_GEOPS_PIN_ID: 'Identificador GEOPS de geozona en el archivo',
};

export function signalName(code: string): string {
  if (code.startsWith('SOURCE_NAMESPACE:')) return 'Fuente de referencia del catálogo';
  return signals[code] ?? 'Otra señal de coincidencia';
}

export function candidateKind(candidate: Candidate): string {
  switch (candidate.target_type) {
    case 'CUSTOMER':
      return 'Cliente existente';
    case 'ESTABLISHMENT':
      return 'Sede existente';
    case 'PIN':
      return 'Geozona existente';
    case 'STAGING_RECORD':
      return 'Otro registro del KMZ';
    default:
      return 'Coincidencia';
  }
}

export function confidenceName(value: string): string {
  switch (value) {
    case 'IDENTIFIER':
      return 'Identificador explícito';
    case 'CORROBORATED':
      return 'Nombre y ubicación coinciden';
    case 'POSSIBLE':
      return 'Posible coincidencia';
    default:
      return 'Indicio débil';
  }
}
