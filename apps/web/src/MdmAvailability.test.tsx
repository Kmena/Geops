import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MdmOnly, mdmEnabled } from './MdmAvailability.js';

test('MDM controls are absent from the default Staging 1 Web bundle', () => {
  assert.equal(mdmEnabled, false);
  assert.equal(renderToStaticMarkup(MdmOnly({ children: 'Sincronizar MDM' })), '');
  assert.equal(renderToStaticMarkup(MdmOnly({ enabled: false, children: 'Vincular MDM' })), '');
  assert.equal(
    renderToStaticMarkup(MdmOnly({ enabled: true, children: 'Integración MDM' })),
    'Integración MDM',
  );
});
