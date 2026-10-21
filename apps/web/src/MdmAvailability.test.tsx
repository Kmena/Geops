import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MdmOnly, mdmEnabled } from './MdmAvailability.js';

test('MDM controls are absent from the default Staging 1 Web bundle', () => {
  assert.equal(mdmEnabled, false);
  assert.equal(renderToStaticMarkup(<MdmOnly>Sincronizar MDM</MdmOnly>), '');
  assert.equal(renderToStaticMarkup(<MdmOnly enabled={false}>Vincular MDM</MdmOnly>), '');
  assert.equal(
    renderToStaticMarkup(<MdmOnly enabled={true}>Integración MDM</MdmOnly>),
    'Integración MDM',
  );
});
