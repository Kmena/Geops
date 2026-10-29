// Playwright CLI run-code fixture against the disposable synthetic API.
async (page) => {
  const check = (value, label) => {
    if (!value) throw new Error(label);
    checks++;
  };
  let checks = 0;
  const code = `W3${Date.now()}`;
  const future = new Date();
  future.setUTCDate(future.getUTCDate() + 49);
  const date = future.toISOString().slice(0, 10);
  const isoDay = future.getUTCDay() || 7;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:3501/schedule');
  await page.getByRole('heading', { name: 'Dispositivos / agentes y calendario' }).waitFor();
  check(page.url().endsWith('/schedule'), 'schedule navigation');
  const browserDevice = await page
    .getByRole('combobox', { name: 'Dispositivo GEOPS existente' })
    .locator('option')
    .filter({ hasText: 'Dispositivo Chrome E2E' })
    .getAttribute('value');
  if (!browserDevice) throw new Error('Synthetic browser device unavailable');
  await page
    .getByRole('combobox', { name: 'Dispositivo GEOPS existente' })
    .selectOption(browserDevice);
  await page.getByRole('textbox', { name: 'Código operativo del dispositivo' }).fill(code);
  await page.getByRole('textbox', { name: 'Nombre visible del agente' }).fill('Agente Wave 3 Web');
  await page
    .getByRole('textbox', { name: 'Responsable actual (opcional)' })
    .fill('Responsable inicial');
  await page.getByRole('button', { name: 'Registrar dispositivo como agente' }).click();
  await page.locator('.schedule-agent-list').getByText(`${code} · Agente Wave 3 Web`).waitFor();
  check(true, 'agent created');
  await page.getByText('Responsable actual: Responsable inicial').waitFor();
  check(true, 'device-backed agent shows initial responsible');
  await page.getByRole('textbox', { name: 'Nuevo responsable' }).fill('Responsable siguiente');
  await page
    .getByRole('textbox', { name: 'Motivo del cambio' })
    .fill('Cambio sintético de responsable');
  await page.getByRole('button', { name: 'Guardar responsable' }).click();
  await page.getByText('Responsable actual: Responsable siguiente').waitFor();
  check(true, 'responsible changes without changing agent');
  check(
    (await page.getByRole('listitem').filter({ hasText: 'Responsable inicial' }).count()) >= 1,
    'previous responsible remains in history',
  );
  const agent = await page.evaluate(async (code) => {
    const result = await fetch('/v1/admin/agents?limit=100').then((response) => response.json());
    return result.items.find((item) => item.code === code);
  }, code);
  check(agent?.state === 'ACTIVE', 'agent persisted');
  const planning = page
    .locator('.schedule-section')
    .filter({ has: page.getByRole('heading', { name: 'Planificación' }) });
  const agentSelect = planning.locator('select').nth(0);
  const routeSelect = planning.locator('select').nth(1);
  await agentSelect.selectOption(agent.id);
  const options = await routeSelect
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, text: node.textContent })));
  const route =
    options.find((item) => item.text.includes('R01')) ?? options.find((item) => item.value);
  check(Boolean(route), 'published route available');
  await routeSelect.selectOption(route.value);
  await planning.locator('input[type=date]').first().fill(date);
  await planning.locator('input[type=time]').nth(0).fill('08:00');
  await planning.locator('input[type=time]').nth(1).fill('09:00');
  await page.getByRole('button', { name: 'Asignar ruta' }).click();
  await page.getByText('Asignación creada.').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.schedule-event').length >= 1);
  check((await page.locator('.schedule-event').count()) >= 1, 'first route in calendar');
  const secondRoute = options.find((item) => item.value && item.value !== route.value);
  check(Boolean(secondRoute), 'second published route available');
  await routeSelect.selectOption(secondRoute.value);
  await planning.locator('input[type=time]').nth(0).fill('09:00');
  await planning.locator('input[type=time]').nth(1).fill('10:00');
  await page.getByRole('button', { name: 'Asignar ruta' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.schedule-event').length >= 2);
  check(
    (await page.locator('.schedule-event').allTextContents()).some((text) =>
      text.includes(secondRoute.text.split(' · ')[0]),
    ),
    'different routes in one day',
  );
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.schedule-event').length >= 2);
  check((await page.locator('.schedule-event').count()) >= 2, 'calendar persists after reload');
  await agentSelect.selectOption(agent.id);
  await routeSelect.selectOption(route.value);
  await planning.locator('input[type=date]').first().fill(date);
  await planning.locator('input[type=time]').nth(0).fill('11:00');
  await planning.locator('input[type=time]').nth(1).fill('12:00');
  const days = page.locator('.schedule-day-options input');
  for (let index = 0; index < 7; index++) {
    if (index + 1 === isoDay) await days.nth(index).check();
    else await days.nth(index).uncheck();
  }
  await page.getByRole('button', { name: 'Crear recurrencia' }).click();
  await page.getByText('Recurrencia creada. Materializa una ventana de hasta 31 días.').waitFor();
  check(true, 'recurrence created');
  await page.getByRole('button', { name: 'Materializar ventana visible' }).click();
  await page.getByText(/Ventana materializada: 1 creadas/).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.schedule-event').length >= 3);
  check((await page.locator('.schedule-event').count()) >= 3, 'recurrence materialized');
  await page.getByLabel('Fecha de excepción').fill(date);
  await page.getByLabel('Acción').selectOption('CANCEL');
  await page.getByRole('button', { name: 'Guardar excepción' }).click();
  await page
    .getByText('Excepción guardada. Materializa la ventana afectada para aplicarla.')
    .waitFor();
  check(true, 'exception saved');
  await page.getByRole('button', { name: 'Materializar ventana visible' }).click();
  await page.getByText(/Ventana materializada: 0 creadas, 1 canceladas/).waitFor();
  await page.locator('.schedule-event.cancelled').first().waitFor();
  check(
    (await page.locator('.schedule-event.cancelled').count()) >= 1,
    'exception cancels occurrence',
  );
  await page.locator('.schedule-event:not(.cancelled)').first().click();
  await page.getByRole('heading', { name: 'Snapshot de asignación' }).waitFor();
  check(
    (await page.locator('#snapshot-title').locator('..').textContent()).includes(
      'geozona circular',
    ),
    'historical snapshot visible',
  );
  await page.getByRole('button', { name: 'Cancelar asignación' }).click();
  await page.getByText('Asignación cancelada.').waitFor();
  check(true, 'manual assignment cancelled');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('heading', { name: 'Calendario' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.schedule-event').length >= 3);
  const mobile = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  check(mobile.scrollWidth <= mobile.width + 2, 'mobile has no horizontal overflow');
  check((await page.locator('.schedule-event').count()) >= 3, 'mobile calendar persisted');
  await page.locator('.schedule-toolbar select').first().selectOption('month');
  await page.waitForFunction(() => document.querySelectorAll('.schedule-day').length >= 28);
  check((await page.locator('.schedule-day').count()) >= 28, 'monthly calendar visible');
  const monthStart = await page.locator('.schedule-day').first().getAttribute('aria-label');
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.waitForFunction(
    (previous) => document.querySelector('.schedule-day')?.getAttribute('aria-label') !== previous,
    monthStart,
  );
  check(
    (await page.locator('.schedule-day').first().getAttribute('aria-label')) > monthStart,
    'next month navigation',
  );
  await page.getByRole('button', { name: 'Anterior' }).click();
  await page.waitForFunction(
    (previous) => document.querySelector('.schedule-day')?.getAttribute('aria-label') === previous,
    monthStart,
  );
  check(
    (await page.locator('.schedule-day').first().getAttribute('aria-label')) === monthStart,
    'previous month navigation',
  );
  await page.locator('.schedule-toolbar select').nth(1).selectOption(agent.id);
  await page.waitForFunction(() => document.querySelectorAll('.schedule-event').length >= 3);
  check((await page.locator('.schedule-event').count()) >= 3, 'agent filter applied');
  await page.goto(`http://127.0.0.1:3501/compliance?from=${date}&to=${date}`);
  await page.getByRole('heading', { name: 'Cumplimiento de visitas' }).waitFor();
  const pendingVisit = page.locator('tr').filter({ hasText: 'Pendiente de evaluación' }).first();
  await pendingVisit.getByRole('button', { name: 'Ver evidencia' }).click();
  check(await pendingVisit.getByText('Aún sin cálculo').count() === 1, 'unevaluated visit does not show zero dwell');
  check(
    await page.getByText('Todavía no se ha calculado la permanencia.').count() === 1,
    'unevaluated detail explains uncertainty',
  );
  check(
    await page.getByRole('button', { name: 'Evaluar visita' }).isDisabled(),
    'future visit cannot be evaluated before the shift ends',
  );
  await page.getByRole('button', { name: 'Mostrar mapa y puntos GPS' }).click();
  await page.waitForFunction(() =>
    !!document.querySelector('.compliance-visit-map') ||
    !!document.querySelector('.compliance-detail [role=alert]'),
  );
  if (!(await page.locator('.compliance-visit-map').count()))
    throw new Error(`visit map request failed: ${await page.locator('.compliance-detail [role=alert]').allTextContents()}`);
  await page.waitForFunction(() =>
    document.querySelectorAll('.compliance-visit-map .leaflet-interactive').length >= 2 ||
    !!document.querySelector('.compliance-visit-map + [role=alert]'),
  );
  check(
    await page.locator('.compliance-visit-map .leaflet-interactive').count() >= 2,
    'visit map renders historical and current geozone',
  );
  return { result: 'PASS', checks, agentId: agent.id, mobile };
}
