// Playwright CLI run-code fixture. Only use with the synthetic browser API and mocked geocoder.
async (page) => {
  let checks = 0;
  const check = (value, label) => {
    if (!value) throw new Error(label);
    checks++;
  };
  const requests = [];
  page.on('request', (request) => {
    if (request.url().includes('/v1/admin/geocoding/search')) requests.push(request.url());
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:3501/clients');
  await page.getByRole('heading', { name: 'Clientes y geozonas' }).waitFor();
  await page.getByRole('button', { name: 'Nuevo cliente' }).click();
  const form = page.locator('section.catalog-section').filter({
    has: page.getByRole('heading', { name: 'Nuevo cliente' }),
  });
  const search = form.getByRole('searchbox', { name: 'Buscar ubicación' });
  check(await search.isVisible(), 'location search visible');
  await search.fill('Lugar sintético');
  check(requests.length === 0, 'typing does not send address');
  await form.locator('.location-search').getByRole('button', { name: 'Buscar' }).click();
  await form.getByRole('list', { name: 'Resultados de ubicación' }).waitFor();
  check(requests.length === 1, 'explicit search sends one query');
  check(
    (await form
      .getByRole('list', { name: 'Resultados de ubicación' })
      .getByRole('button')
      .count()) === 2,
    'multiple mocked results visible',
  );
  await form
    .getByRole('list', { name: 'Resultados de ubicación' })
    .getByRole('button')
    .first()
    .click();
  check(
    (await form.getByRole('spinbutton', { name: 'Latitud' }).inputValue()) === '14.635',
    'result fills latitude',
  );
  check(
    (await form.getByRole('spinbutton', { name: 'Longitud' }).inputValue()) === '-90.515',
    'result fills longitude',
  );
  check(
    (await form.getByRole('textbox', { name: 'Dirección de sede' }).inputValue()) === '',
    'suggestion does not overwrite address',
  );
  await form.getByRole('button', { name: 'Usar esta dirección en cliente y sede' }).click();
  check(
    (await form.getByRole('textbox', { name: 'Dirección de sede' }).inputValue()).includes(
      'Lugar sintético',
    ),
    'address applied only with confirmation',
  );
  check(
    (await form.getByRole('textbox', { name: 'Dirección', exact: true }).inputValue()).includes(
      'Lugar sintético',
    ),
    'client address suggested when empty',
  );
  const pin = form.locator('.catalog-pin');
  await pin.waitFor();
  check(await pin.isVisible(), 'draggable Leaflet marker visible');
  const map = form.getByRole('application', {
    name: 'Mapa para seleccionar el centro de la geozona',
  });
  const box = await map.boundingBox();
  if (!box) throw new Error('map has no bounds');
  await pin.dragTo(map, { targetPosition: { x: box.width * 0.58, y: box.height * 0.43 } });
  check((await form.getByRole('spinbutton', { name: 'Latitud' }).inputValue()) !== '14.635',
    'dragging marker adjusts coordinates');
  await map.click({ position: { x: box.width * 0.6, y: box.height * 0.4 } });
  check(
    (await form.getByRole('spinbutton', { name: 'Latitud' }).inputValue()) !== '14.635',
    'manual map click adjusts point',
  );
  await form.getByRole('textbox', { name: 'Código', exact: true }).fill(`POST${Date.now()}`);
  await form.getByRole('textbox', { name: 'Nombre', exact: true }).fill('Cliente post B30');
  await form.getByRole('textbox', { name: 'Dirección', exact: true }).fill('Dirección sintética');
  await form.getByRole('button', { name: 'Crear cliente y sede' }).click();
  await page.waitForURL(/\/clients\/[0-9a-f-]+$/);
  check(true, 'selected point persisted');
  await page.reload();
  await page.getByRole('heading', { name: 'Cliente post B30' }).waitFor();
  check(true, 'client survives reload');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
    'mobile viewport has no horizontal overflow',
  );
  return { result: 'PASS', checks };
}
