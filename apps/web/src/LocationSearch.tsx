import { useState } from 'react';
import { api, ApiClientError, type GeocodingResult } from './api/client.js';

export function LocationSearch({
  onSelect,
  onUseAddress,
  addressButtonLabel = 'Usar esta dirección en la sede',
}: {
  onSelect: (latitude: number, longitude: number) => void;
  onUseAddress: (address: string) => void;
  addressButtonLabel?: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodingResult[]>([]);
  const [selected, setSelected] = useState<GeocodingResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const search = async () => {
    const text = query.trim();
    if (text.length < 3) {
      setError('Escribe al menos tres caracteres para buscar.');
      return;
    }
    setBusy(true);
    setError('');
    setSelected(null);
    try {
      const response = await api.geocodingSearch(text);
      setResults(response.items);
      if (response.items.length === 0)
        setError(
          'No se encontraron lugares. Ajusta la búsqueda o selecciona el punto manualmente.',
        );
    } catch (failure) {
      setResults([]);
      if (failure instanceof ApiClientError && failure.status === 429)
        setError('Demasiadas búsquedas. Espera un momento y vuelve a intentarlo.');
      else if (failure instanceof ApiClientError && failure.status === 403)
        setError('Tu cuenta no tiene permiso para buscar ubicaciones.');
      else
        setError(
          'La búsqueda no está disponible. Puedes usar el mapa o escribir las coordenadas sin perder el formulario.',
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="location-search">
      <label htmlFor="geocoding-query">Buscar ubicación</label>
      <div className="location-search-input">
        <input
          id="geocoding-query"
          type="search"
          maxLength={160}
          autoComplete="off"
          placeholder="Establecimiento, dirección, barrio o ciudad"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (!busy) void search();
            }
          }}
        />
        <button type="button" disabled={busy} onClick={() => void search()}>
          {busy ? 'Buscando…' : 'Buscar'}
        </button>
      </div>
      <p className="location-search-note">
        Al pulsar Buscar se enviará el texto a Nominatim, un servicio público de OpenStreetMap. No
        incluyas datos personales.
      </p>
      {error && <p role="alert">{error}</p>}
      {results.length > 0 && (
        <ul className="location-search-results" aria-label="Resultados de ubicación">
          {results.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => {
                  setSelected(item);
                  onSelect(item.latitude, item.longitude);
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <div className="location-search-suggestion">
          <p>Dirección sugerida: {selected.label}</p>
          <button type="button" className="secondary" onClick={() => onUseAddress(selected.label)}>
            {addressButtonLabel}
          </button>
        </div>
      )}
      <small>
        Datos de búsqueda ©{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          colaboradores de OpenStreetMap
        </a>
        .
      </small>
    </div>
  );
}
