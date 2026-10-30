// Playwright CLI run-code fixture against the disposable synthetic API and Chrome.
async (page) => {
  let checks = 0;
  const check = (value, label) => { if (!value) throw new Error(label); checks++; };
  const date = new Date(Date.now() + 32 * 86400000).toISOString().slice(0, 10);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:3501/compliance?from=${date}&to=${date}`);
  await page.getByRole('heading', { name: 'Verificación de rutas' }).waitFor();
  check(page.url().includes('/compliance'), 'dashboard opens');
  await page.locator('.compliance-tile').first().waitFor();
  check(await page.locator('.compliance-tile').count() === 11, 'indicator grid');
  check((await page.getByText('Los resultados pueden cambiar', { exact: false }).count()) === 1,
    'provisional warning shown');
  const response = await page.evaluate(async (date) => {
    return fetch(`/v1/admin/compliance?from=${date}&to=${date}&limit=50`).then(r => r.json());
  }, date);
  check(response.total_visits > 0, 'persisted visits shown');
  check(await page.getByRole('tab', { name: 'Rutas' }).getAttribute('aria-selected') === 'true',
    'route verification is the initial view');
  check(await page.locator('.compliance-cards article').count() === response.routes.length,
    'route breakdown');
  await page.getByRole('tab', { name: 'Visitas' }).click();
  check((await page.locator('.compliance-table-wrap tbody tr').count()) === response.items.length,
    'table matches API page');
  await page.getByRole('tab', { name: 'Rutas' }).click();
  await page.locator('.compliance-cards article').first().getByRole('button', { name: 'Ver visitas y permanencia' }).click();
  await page.waitForURL(/assignment_id=/);
  check(await page.getByRole('tab', { name: 'Visitas' }).getAttribute('aria-selected') === 'true',
    'route drilldown opens matching visits');
  const assignmentId = new URL(page.url()).searchParams.get('assignment_id');
  check((await page.locator('.compliance-table-wrap tbody tr').count()) > 0, 'assignment has visits');
  const assignmentResponse = await page.evaluate(async () => {
    const params = new URLSearchParams(location.search);
    params.set('limit', '50');
    return fetch(`/v1/admin/compliance?${params}`).then(r => r.json());
  });
  check(assignmentResponse.items.every(item => item.assignment_id === assignmentId),
    'route drilldown contains only the selected assignment');
  await page.goto(`http://127.0.0.1:3501/compliance?from=${date}&to=${date}`);
  await page.locator('.compliance-tile').first().waitFor();
  await page.getByRole('tab', { name: 'Visitas' }).click();
  await page.getByRole('tab', { name: 'Dispositivos / agentes' }).click();
  check(await page.locator('.compliance-cards article').count() === response.agents.length,
    'agent breakdown');
  await page.getByRole('tab', { name: 'Clientes' }).click();
  check(await page.locator('.compliance-cards article').count() === response.clients.length,
    'client breakdown');
  await page.getByRole('tab', { name: 'Mapa' }).click();
  await page.locator('.leaflet-overlay-pane path').first().waitFor();
  check(await page.locator('.leaflet-overlay-pane path').count() >= response.items.length,
    'circular geofences on map');
  check(await page.locator('.compliance-legend span').count() === 8, 'accessible status legend');
  check(!response.location_access || await page.getByRole('heading', { name: 'Comunicación de dispositivos vinculados' }).count() === 1,
    'authorized device communication panel');
  await page.getByRole('tab', { name: 'Visitas' }).click();
  const evaluatedIndex = response.items.findIndex(item => item.evaluation_id);
  const index = evaluatedIndex >= 0 ? evaluatedIndex : 0;
  await page.locator('.compliance-table-wrap tbody tr').nth(index).getByRole('button', { name: 'Ver evidencia' }).click();
  await page.getByRole('heading', { name: 'Historial de evaluaciones' }).waitFor();
  check(await page.getByLabel('Detalle de visita').count() === 1, 'visit detail opens');
  check((await page.getByLabel('Detalle de visita').textContent()).includes('Geozona histórica'),
    'historical snapshot displayed');
  if (evaluatedIndex >= 0) {
    await page.getByRole('button', { name: 'Consultar intervalos y referencias GPS' }).click();
    await page.getByRole('heading', { name: 'Intervalos acreditados', exact: true }).waitFor();
  }
  check(evaluatedIndex < 0 || await page.getByRole('heading', { name: 'Intervalos acreditados', exact: true }).count() === 1,
    'evidence request audited and displayed');
  await page.getByRole('button', { name: 'Cerrar detalle' }).click();
  await page.getByLabel('Dispositivo / agente', { exact: true }).fill(response.items[0].agent_id);
  await page.getByRole('button', { name: 'Aplicar filtros' }).click();
  await page.waitForURL(/agent_id=/);
  check((await page.locator('.compliance-table-wrap tbody tr').count()) > 0,
    'agent filter updates table');
  await page.reload();
  await page.locator('.compliance-tile').first().waitFor();
  check(page.url().includes(`agent_id=${response.items[0].agent_id}`), 'filter survives reload');
  await page.getByRole('tab', { name: 'Visitas' }).click();
  await page.getByLabel('Dispositivo / agente', { exact: true }).fill('');
  await page.getByLabel('Desde').fill('2030-01-01');
  await page.getByLabel('Hasta').fill('2030-01-01');
  await page.getByRole('button', { name: 'Aplicar filtros' }).click();
  await page.getByText('No hay visitas para estos filtros.').waitFor();
  check(await page.locator('.compliance-table-wrap tbody tr').count() === 0, 'empty state');
  await page.route('**/v1/admin/compliance?*', route => route.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'synthetic_failure' } }),
  }));
  await page.getByRole('button', { name: 'Actualizar' }).click();
  await page.getByRole('alert').first().waitFor();
  check(await page.getByRole('alert').count() >= 1, 'API error state');
  await page.unroute('**/v1/admin/compliance?*');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator('.compliance-tile').first().waitFor();
  check(await page.locator('.compliance-filters').isVisible(), 'mobile filters visible');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'mobile dashboard has no page overflow');
  await page.getByRole('tab', { name: 'Rutas' }).click();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'mobile route cards have no page overflow');
  return { result: 'PASS', checks };
}
