// Playwright CLI run-code fixture. Run only with the disposable synthetic API fixture.
// The final function expression deliberately has no semicolon: CLI wraps it as await (<file>)(page).
async (page) => {
  const ensure = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const code = `E2E${Date.now()}`;
  let checks = 0;
  const check = (condition, message) => {
    ensure(condition, message);
    checks += 1;
  };

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:3501/clients');
  const signIn = page.getByRole('button', { name: 'Entrar' });
  await signIn
    .or(page.getByRole('heading', { name: 'Clientes y geozonas' }))
    .first()
    .waitFor();
  if (await signIn.isVisible()) {
    await page.getByRole('textbox', { name: 'Correo electrónico' }).fill('owner@example.invalid');
    await page.getByRole('textbox', { name: 'Contraseña' }).fill('synthetic-password-12345678');
    await signIn.click();
    await page.getByRole('link', { name: 'Clientes y geozonas' }).click();
  }
  await page.getByRole('heading', { name: 'Clientes y geozonas' }).waitFor();
  check(page.url().endsWith('/clients'), 'catalog navigation');
  const desktop = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  check(
    desktop.width === 1280 && desktop.scrollWidth <= 1282,
    'desktop viewport has no horizontal overflow',
  );

  const search = page.getByRole('textbox', { name: 'Buscar cliente' });
  await search.fill('E2E_DOES_NOT_EXIST');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await page.getByText('No hay clientes con esos filtros.').waitFor();
  checks += 1;
  await search.fill('');
  await page.getByRole('button', { name: 'Buscar' }).click();

  await page.getByRole('button', { name: 'Nuevo cliente' }).click();
  const creation = page.locator('section.catalog-section').filter({
    has: page.getByRole('heading', { name: 'Nuevo cliente' }),
  });
  await creation.getByRole('textbox', { name: 'Código', exact: true }).fill(code);
  await creation
    .getByRole('textbox', { name: 'Nombre', exact: true })
    .fill('Cliente E2E sintético');
  await creation
    .getByRole('textbox', { name: 'Dirección', exact: true })
    .fill('Dirección sintética');
  await creation.getByRole('textbox', { name: 'Dirección de sede' }).fill('Sede sintética');
  await creation.getByRole('spinbutton', { name: 'Latitud' }).fill('14.634');
  await creation.getByRole('spinbutton', { name: 'Longitud' }).fill('-90.515');
  await creation.getByRole('button', { name: 'Crear cliente y sede' }).click();
  await page.waitForURL(/\/clients\/[0-9a-f-]+$/);
  await page.getByRole('heading', { name: 'Cliente E2E sintético' }).waitFor();
  const clientId = page.url().split('/').at(-1);
  check(Boolean(clientId), 'client persisted and navigated');

  const zone = page.locator('section.catalog-section').filter({
    has: page.getByRole('heading', { name: 'Geozona circular' }),
  });
  await zone.getByText('Sin geozona configurada').waitFor();
  await zone.getByRole('spinbutton', { name: 'Radio en metros' }).fill('200');
  await zone.getByRole('spinbutton', { name: 'Permanencia mínima en minutos' }).fill('15');
  await zone.getByRole('textbox', { name: 'Motivo del cambio' }).fill('Creación E2E sintética');

  const latitude = zone.getByRole('spinbutton', { name: 'Latitud del centro' });
  const longitude = zone.getByRole('spinbutton', { name: 'Longitud del centro' });
  const before = `${await latitude.inputValue()},${await longitude.inputValue()}`;
  const map = zone.getByRole('application', {
    name: 'Mapa para seleccionar el centro de la geozona',
  });
  const box = await map.boundingBox();
  ensure(box && box.width > 100 && box.height > 100, 'map has usable size');
  await map.click({ position: { x: box.width * 0.42, y: box.height * 0.58 } });
  const after = `${await latitude.inputValue()},${await longitude.inputValue()}`;
  check(after !== before, 'map click updates coordinates');

  await zone.getByRole('button', { name: 'Guardar nueva revisión' }).click();
  await zone.getByText('Revisión 1 · Activa', { exact: true }).waitFor();
  checks += 1;
  const loadZones = () =>
    page.evaluate(async (id) => {
      const sites = await fetch(`/v1/admin/clients/${id}/sites`).then((res) => res.json());
      const siteId = sites.items[0].id;
      const result = await fetch(`/v1/admin/clients/${id}/sites/${siteId}/geofences`).then((res) =>
        res.json(),
      );
      return result.items;
    }, clientId);
  let revisions = await loadZones();
  check(
    revisions.length === 1 && revisions[0].radius_m === 200 && revisions[0].min_dwell_s === 900,
    'PostGIS revision stores meter radius and 15-minute dwell',
  );
  check(
    Math.abs(revisions[0].latitude - Number(await latitude.inputValue())) < 0.000001,
    'persisted center matches map selection',
  );

  await page.reload();
  await zone.getByText('Revisión 1 · Activa', { exact: true }).waitFor();
  check(
    (await zone.getByRole('spinbutton', { name: 'Radio en metros' }).inputValue()) === '200',
    'radius restored after reload',
  );
  check(
    (await zone.locator('.leaflet-overlay-pane path').count()) >= 2,
    'Leaflet renders center and circle',
  );
  await zone.getByRole('spinbutton', { name: 'Radio en metros' }).fill('250');
  await zone.getByRole('textbox', { name: 'Motivo del cambio' }).fill('Ajuste E2E de radio');
  await zone.getByRole('button', { name: 'Guardar nueva revisión' }).click();
  await zone.getByText('Revisión 2 · Activa', { exact: true }).waitFor();
  revisions = await loadZones();
  check(
    revisions.length === 2 && revisions[0].radius_m === 250 && revisions[1].radius_m === 200,
    'radius edit preserves immutable history',
  );

  await zone.getByRole('combobox', { name: 'Estado' }).selectOption('INACTIVE');
  await zone
    .getByRole('textbox', { name: 'Motivo del cambio' })
    .fill('Desactivación E2E sintética');
  await zone.getByRole('button', { name: 'Guardar nueva revisión' }).click();
  await zone.getByText('Revisión 3 · Inactiva', { exact: true }).waitFor();
  revisions = await loadZones();
  check(
    revisions.length === 3 && revisions[0].state === 'INACTIVE',
    'geofence deactivation is versioned',
  );
  await page.getByRole('button', { name: 'Desactivar', exact: true }).click();
  await page.getByRole('button', { name: 'Activar', exact: true }).waitFor();
  const state = await page.evaluate(
    async (id) => fetch(`/v1/admin/clients/${id}`).then((res) => res.json()),
    clientId,
  );
  check(state.state === 'INACTIVE', 'client deactivation persists');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await zone.getByText('Revisión 3 · Inactiva', { exact: true }).waitFor();
  const mobile = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  check(mobile.scrollWidth <= mobile.width + 2, 'mobile viewport has no horizontal overflow');
  check(
    await zone.getByRole('button', { name: 'Guardar nueva revisión' }).isVisible(),
    'mobile save action visible',
  );
  return { result: 'PASS', checks, clientId, viewport: mobile };
}
