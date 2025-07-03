// Copyright 2025 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {assert} from 'chai';
import type * as puppeteer from 'puppeteer-core';

import {AsyncScope} from '../../conductor/async-scope.js';
import {installPageErrorHandlers} from '../../conductor/events.js';
import {platform} from '../../conductor/platform.js';
import {TestConfig} from '../../conductor/test_config.js';

import type {BrowserWrapper} from './browser-helper.js';
import {PageWrapper} from './page-wrapper.js';

export type Action = (element: puppeteer.ElementHandle) => Promise<void>;

export interface ClickOptions {
  root?: puppeteer.ElementHandle;
  clickOptions?: puppeteer.ClickOptions;
  maxPixelsFromLeft?: number;
}

const envThrottleRate = process.env['STRESS'] ? 3 : 1;
const envLatePromises = process.env['LATE_PROMISES'] !== undefined ?
    ['true', ''].includes(process.env['LATE_PROMISES'].toLowerCase()) ? 10 : Number(process.env['LATE_PROMISES']) :
    0;

type DeducedElementType<ElementType extends Element|null, Selector extends string> =
    ElementType extends null ? puppeteer.NodeFor<Selector>: ElementType;

const CONTROL_OR_META = platform === 'mac' ? 'Meta' : 'Control';

// TODO: Remove once Chromium updates its version of Node.js to 12+.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalThis: any = global;

export class DevToolsPage extends PageWrapper {
  #currentHighlightedElement?: HighlightedElement;

  async delayPromisesIfRequired(): Promise<void> {
    if (envLatePromises === 0) {
      return;
    }
    /* eslint-disable-next-line no-console */
    console.log(`Delaying promises by ${envLatePromises}ms`);
    await this.evaluate(delay => {
      global.Promise = class<T> extends Promise<T>{
        constructor(
            executor: (resolve: (value: T|PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void) {
          super((resolve, reject) => {
            executor(
                value => setTimeout(() => resolve(value), delay), reason => setTimeout(() => reject(reason), delay));
          });
        }
      };
    }, envLatePromises);
  }

  async throttleCPUIfRequired(): Promise<void> {
    if (envThrottleRate === 1) {
      return;
    }
    /* eslint-disable-next-line no-console */
    console.log(`Throttling CPU: ${envThrottleRate}x slowdown`);
    const client = await this.page.createCDPSession();
    await client.send('Emulation.setCPUThrottlingRate', {
      rate: envThrottleRate,
    });
  }

  async ensureReadyForTesting() {
    await this.page.waitForFunction(`
      (async function() {
        const Main = await import('./entrypoints/main/main.js');
        return Main.MainImpl.MainImpl.instanceForTest !== null;
        })()
        `);
    await this.evaluate(`
      (async function() {
        const Main = await import('./entrypoints/main/main.js');
        await Main.MainImpl.MainImpl.instanceForTest.readyForTest();
      })();
    `);
  }

  async useSoftMenu() {
    await this.page.evaluate('window.DevToolsAPI.setUseSoftMenu(true)');
  }

  /**
   * Get a single element handle. Uses `pierce` handler per default for piercing Shadow DOM.
   */
  async $<ElementType extends Element|null = null, Selector extends string = string>(
      selector: Selector, root?: puppeteer.ElementHandle, handler = 'pierce') {
    const rootElement = root ? root : this.page;
    const element = await rootElement.$(`${handler}/${selector}`) as
        puppeteer.ElementHandle<DeducedElementType<ElementType, Selector>>;
    await this.#maybeHighlight(element);
    return element;
  }

  async #maybeHighlight(element: puppeteer.ElementHandle) {
    if (!TestConfig.debug) {
      return;
    }
    if (!element) {
      return;
    }
    if (this.#currentHighlightedElement) {
      await this.#currentHighlightedElement.reset();
    }
    this.#currentHighlightedElement = new HighlightedElement(element);
    await this.#currentHighlightedElement.highlight();
  }

  async performActionOnSelector(selector: string, options: {root?: puppeteer.ElementHandle}, action: Action):
      Promise<puppeteer.ElementHandle> {
    // TODO(crbug.com/1410168): we should refactor waitFor to be compatible with
    // Puppeteer's syntax for selectors.
    const queryHandlers = new Set([
      'pierceShadowText',
      'pierce',
      'aria',
      'xpath',
      'text',
    ]);
    let queryHandler = 'pierce';
    for (const handler of queryHandlers) {
      const prefix = handler + '/';
      if (selector.startsWith(prefix)) {
        queryHandler = handler;
        selector = selector.substring(prefix.length);
        break;
      }
    }
    return await this.waitForFunction(async () => {
      const element = await this.waitFor(selector, options?.root, undefined, queryHandler);
      try {
        await action(element);
        await this.drainTaskQueue();
        return element;
      } catch {
        return undefined;
      }
    });
  }

  async waitFor<ElementType extends Element|null = null, Selector extends string = string>(
      selector: Selector, root?: puppeteer.ElementHandle, asyncScope = new AsyncScope(), handler?: string) {
    return await asyncScope.exec(() => this.waitForFunction(async () => {
      const element = await this.$<ElementType, typeof selector>(selector, root, handler);
      return (element || undefined);
    }, asyncScope), `Waiting for element matching selector '${handler ? `${handler}/` : ''}${selector}'`);
  }

  /**
   * Schedules a task in the frontend page that ensures that previously
   * handled tasks have been handled.
   */
  async drainTaskQueue(): Promise<void> {
    await this.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  async typeText(text: string, opts?: {delay: number}) {
    await this.page.keyboard.type(text, opts);
    await this.drainTaskQueue();
  }

  async click(selector: string, options?: ClickOptions) {
    return await this.performActionOnSelector(
        selector,
        {root: options?.root},
        element => element.click(options?.clickOptions),
    );
  }

  async hover(selector: string, options?: {root?: puppeteer.ElementHandle}) {
    return await this.performActionOnSelector(
        selector,
        {root: options?.root},
        element => element.hover(),
    );
  }

  waitForAria<ElementType extends Element = Element>(
      selector: string, root?: puppeteer.ElementHandle, asyncScope = new AsyncScope()) {
    return this.waitFor<ElementType>(selector, root, asyncScope, 'aria');
  }

  async waitForNone(selector: string, root?: puppeteer.ElementHandle, asyncScope = new AsyncScope(), handler?: string) {
    return await asyncScope.exec(() => this.waitForFunction(async () => {
      const elements = await this.$$(selector, root, handler);
      if (elements.length === 0) {
        return true;
      }
      return false;
    }, asyncScope), `Waiting for no elements to match selector '${handler ? `${handler}/` : ''}${selector}'`);
  }

  /**
   * Get multiple element handles. Uses `pierce` handler per default for piercing Shadow DOM.
   */
  async $$<ElementType extends Element|null = null, Selector extends string = string>(
      selector: Selector, root?: puppeteer.JSHandle, handler = 'pierce') {
    const rootElement = root ? root.asElement() || this.page : this.page;
    const elements = await rootElement.$$(`${handler}/${selector}`) as
        Array<puppeteer.ElementHandle<DeducedElementType<ElementType, Selector>>>;
    return elements;
  }

  /**
   * @deprecated This method is not able to recover from unstable DOM. Use click(selector) instead.
   */
  async clickElement(element: puppeteer.ElementHandle, options?: ClickOptions): Promise<void> {
    // Retries here just in case the element gets connected to DOM / becomes visible.
    await this.waitForFunction(async () => {
      try {
        await element.click(options?.clickOptions);
        await this.drainTaskQueue();
        return true;
      } catch {
        return false;
      }
    });
  }

  waitForElementWithTextContent(textContent: string, root?: puppeteer.ElementHandle, asyncScope = new AsyncScope()) {
    return this.waitFor(textContent, root, asyncScope, 'pierceShadowText');
  }

  async scrollElementIntoView(selector: string, root?: puppeteer.ElementHandle) {
    const element = await this.$(selector, root);

    if (!element) {
      throw new Error(`Unable to find element with selector "${selector}"`);
    }

    await element.evaluate(el => {
      el.scrollIntoView({
        behavior: 'instant',
        block: 'center',
        inline: 'center',
      });
    });
  }

  /**
   * Search for all elements based on their textContent
   *
   * @param textContent The text content to search for.
   * @param root The root of the search.
   */
  async $$textContent(textContent: string, root?: puppeteer.ElementHandle) {
    return await this.$$(textContent, root, 'pierceShadowText');
  }

  waitForNoElementsWithTextContent(textContent: string, root?: puppeteer.ElementHandle, asyncScope = new AsyncScope()) {
    return asyncScope.exec(() => this.waitForFunction(async () => {
      const elems = await this.$$textContent(textContent, root);
      if (elems && elems.length === 0) {
        return true;
      }

      return false;
    }, asyncScope), `Waiting for no elements with textContent '${textContent}'`);
  }

  async withControlOrMetaKey(action: () => Promise<void>, root = this.page) {
    await this.waitForFunction(async () => {
      await root.keyboard.down(CONTROL_OR_META);
      try {
        await action();
        return true;
      } finally {
        await root.keyboard.up(CONTROL_OR_META);
      }
    });
  }

  /**
   * @deprecated This method is not able to recover from unstable DOM. Use hover(selector) instead.
   */
  async hoverElement(element: puppeteer.ElementHandle): Promise<void> {
    // Retries here just in case the element gets connected to DOM / becomes visible.
    await this.waitForFunction(async () => {
      try {
        await element.hover();
        await this.drainTaskQueue();
        return true;
      } catch {
        return false;
      }
    });
  }

  async doubleClick(
      selector: string, options?: {root?: puppeteer.ElementHandle, clickOptions?: puppeteer.ClickOptions}) {
    const passedClickOptions = (options?.clickOptions) || {};
    const clickOptionsWithDoubleClick: puppeteer.ClickOptions = {
      ...passedClickOptions,
      clickCount: 2,
    };
    return await this.click(selector, {
      ...options,
      clickOptions: clickOptionsWithDoubleClick,
    });
  }

  async pasteText(text: string) {
    await this.page.keyboard.sendCharacter(text);
    await this.drainTaskQueue();
  }

  /**
   * Search for an element based on its textContent.
   *
   * @param textContent The text content to search for.
   * @param root The root of the search.
   */
  async $textContent(textContent: string, root?: puppeteer.ElementHandle) {
    return await this.$(textContent, root, 'pierceShadowText');
  }

  async getTextContent<ElementType extends Element = Element>(selector: string, root?: puppeteer.ElementHandle) {
    const text = await (await this.$<ElementType, typeof selector>(selector, root))?.evaluate(node => node.textContent);
    return text ?? undefined;
  }

  async getAllTextContents(selector: string, root?: puppeteer.JSHandle, handler = 'pierce'):
      Promise<Array<string|null>> {
    const allElements = await this.$$(selector, root, handler);
    return await Promise.all(allElements.map(e => e.evaluate(e => e.textContent)));
  }

  /**
   * Match multiple elements based on a selector and return their textContents, but only for those
   * elements that are visible.
   *
   * @param selector jquery selector to match
   * @returns array containing text contents from visible elements
   */
  async getVisibleTextContents(selector: string) {
    const allElements = await this.$$(selector);
    const texts = await Promise.all(
        allElements.map(el => el.evaluate(node => node.checkVisibility() ? node.textContent?.trim() : undefined)));
    return texts.filter(content => typeof (content) === 'string');
  }

  async waitForVisible<ElementType extends Element|null = null, Selector extends string = string>(
      selector: Selector, root?: puppeteer.ElementHandle, asyncScope = new AsyncScope(), handler?: string) {
    return await asyncScope.exec(() => this.waitForFunction(async () => {
      const element = await this.$<ElementType, typeof selector>(selector, root, handler);
      const visible = await element.evaluate(node => node.checkVisibility());
      return visible ? element : undefined;
    }, asyncScope), `Waiting for element matching selector '${handler ? `${handler}/` : ''}${selector}' to be visible`);
  }

  async waitForMany<ElementType extends Element|null = null, Selector extends string = string>(
      selector: Selector, count: number, root?: puppeteer.ElementHandle, asyncScope = new AsyncScope(),
      handler?: string) {
    return await asyncScope.exec(() => this.waitForFunction(async () => {
      const elements = await this.$$<ElementType, typeof selector>(selector, root, handler);
      return elements.length >= count ? elements : undefined;
    }, asyncScope), `Waiting for ${count} elements to match selector '${handler ? `${handler}/` : ''}${selector}'`);
  }

  waitForAriaNone = (selector: string, root?: puppeteer.ElementHandle, asyncScope = new AsyncScope()) => {
    return this.waitForNone(selector, root, asyncScope, 'aria');
  };

  waitForElementsWithTextContent(textContent: string, root?: puppeteer.ElementHandle, asyncScope = new AsyncScope()) {
    return asyncScope.exec(() => this.waitForFunction(async () => {
      const elems = await this.$$textContent(textContent, root);
      if (elems?.length) {
        return elems;
      }

      return undefined;
    }, asyncScope), `Waiting for elements with textContent '${textContent}'`);
  }

  async waitForFunctionWithTries<T>(
      fn: () => Promise<T|undefined>, options: {tries: number} = {
        tries: Number.MAX_SAFE_INTEGER,
      },
      asyncScope = new AsyncScope()) {
    return await asyncScope.exec(async () => {
      let tries = 0;
      while (tries++ < options.tries) {
        const result = await fn();
        if (result) {
          return result;
        }
        await this.timeout(100);
      }
      return undefined;
    });
  }

  async waitForWithTries(
      selector: string, root?: puppeteer.ElementHandle, options: {tries: number} = {
        tries: Number.MAX_SAFE_INTEGER,
      },
      asyncScope = new AsyncScope(), handler?: string) {
    return await asyncScope.exec(() => this.waitForFunctionWithTries(async () => {
      const element = await this.$(selector, root, handler);
      return (element || undefined);
    }, options, asyncScope));
  }

  debuggerStatement() {
    return this.page.evaluate(() => {
      // eslint-disable-next-line no-debugger
      debugger;
    });
  }

  async waitForAnimationFrame() {
    await this.page.waitForFunction(() => {
      return new Promise(resolve => {
        requestAnimationFrame(resolve);
      });
    });
  }

  async activeElement() {
    await this.waitForAnimationFrame();

    return await this.page.evaluateHandle(() => {
      let activeElement = document.activeElement;

      while (activeElement?.shadowRoot) {
        activeElement = activeElement.shadowRoot.activeElement;
      }

      if (!activeElement) {
        throw new Error('No active element found');
      }

      return activeElement;
    });
  }

  async activeElementTextContent() {
    const element = await this.activeElement();
    return await element.evaluate(node => node.textContent);
  }

  async activeElementAccessibleName() {
    const element = await this.activeElement();
    return await element.evaluate(node => node.getAttribute('aria-label') || node.getAttribute('title'));
  }

  async tabForward(page?: puppeteer.Page) {
    await (page ?? this.page).keyboard.press('Tab');
  }

  async tabBackward(page?: puppeteer.Page) {
    const targetPage = page ?? this.page;
    await targetPage.keyboard.down('Shift');
    await targetPage.keyboard.press('Tab');
    await targetPage.keyboard.up('Shift');
  }

  async clickMoreTabsButton(root?: puppeteer.ElementHandle<Element>) {
    await this.click('aria/More tabs', {root});
  }

  async closePanelTab(panelTabSelector: string) {
    // Get close button from tab element
    const selector = `${panelTabSelector} > .tabbed-pane-close-button`;
    await this.click(selector);
    await this.waitForNone(selector);
  }

  async closeAllCloseableTabs() {
    // get all closeable tools by looking for the available x buttons on tabs
    const selector = '.tabbed-pane-close-button';
    const allCloseButtons = await this.$$(selector);

    // Get all panel ids
    const panelTabIds = await Promise.all(allCloseButtons.map(button => {
      return button.evaluate(button => button.parentElement ? button.parentElement.id : '');
    }));

    // Close each tab
    for (const tabId of panelTabIds) {
      const selector = `#${tabId}`;
      await this.closePanelTab(selector);
    }
  }

  // Noisy! Do not leave this in your test but it may be helpful
  // when debugging.
  async enableCDPLogging() {
    await this.page.evaluate(() => {
      globalThis.ProtocolClient.test.dumpProtocol = console.log;  // eslint-disable-line no-console
    });
  }

  async enableCDPTracking() {
    await this.page.evaluate(() => {
      globalThis.__messageMapForTest = new Map();
      globalThis.ProtocolClient.test.onMessageSent = (message: {method: string, id: number}) => {
        globalThis.__messageMapForTest.set(message.id, message.method);
      };
      globalThis.ProtocolClient.test.onMessageReceived = (message: {id?: number}) => {
        if (message.id) {
          globalThis.__messageMapForTest.delete(message.id);
        }
      };
    });
  }

  async logOutstandingCDP() {
    await this.page.evaluate(() => {
      for (const entry of globalThis.__messageMapForTest) {
        console.error(entry);
      }
    });
  }

  installEventListener(eventType: string) {
    return this.page.evaluate(eventType => {
      window.__pendingEvents = window.__pendingEvents || new Map();
      window.addEventListener(eventType, (e: Event) => {
        let events = window.__pendingEvents.get(eventType);
        if (!events) {
          events = [];
          window.__pendingEvents.set(eventType, events);
        }
        events.push(e);
      });
    }, eventType);
  }

  getPendingEvents(eventType: string): Promise<Event[]|undefined> {
    return this.page.evaluate(eventType => {
      if (!('__pendingEvents' in window)) {
        return undefined;
      }
      const pendingEvents = window.__pendingEvents.get(eventType);
      window.__pendingEvents.set(eventType, []);
      return pendingEvents;
    }, eventType);
  }

  async hasClass(element: puppeteer.ElementHandle<Element>, classname: string) {
    return await element.evaluate((el, classname) => el.classList.contains(classname), classname);
  }

  async waitForClass(element: puppeteer.ElementHandle<Element>, classname: string) {
    await this.waitForFunction(async () => {
      return await this.hasClass(element, classname);
    });
  }

  async renderCoordinatorQueueEmpty() {
    await this.page.evaluate(() => {
      return new Promise<void>(resolve => {
        const pendingFrames = globalThis.__getRenderCoordinatorPendingFrames();
        if (pendingFrames < 1) {
          resolve();
          return;
        }
        globalThis.addEventListener('renderqueueempty', resolve, {once: true});
      });
    });
  }

  async setCheckBox(selector: string, wantChecked: boolean) {
    const checkbox = await this.waitFor(selector);
    const checked = await checkbox.evaluate(box => (box as HTMLInputElement).checked);
    if (checked !== wantChecked) {
      await this.click(`${selector} + label`);
    }
    assert.strictEqual(await checkbox.evaluate(box => (box as HTMLInputElement).checked), wantChecked);
  }

  async summonSearchBox() {
    await this.pressKey('f', {control: true});
  }

  async readClipboard(browserWrapper: BrowserWrapper) {
    await browserWrapper.browser.defaultBrowserContext().overridePermissions(this.page.url(), ['clipboard-read']);
    const clipboard = await this.page.evaluate(async () => await navigator.clipboard.readText());
    await browserWrapper.browser.defaultBrowserContext().clearPermissionOverrides();
    return clipboard;
  }
}

export interface DevtoolsSettings {
  enabledDevToolsExperiments: string[];
  devToolsSettings: Record<string, string|boolean>;
  // front_end/ui/legacy/DockController.ts DockState
  dockingMode: 'bottom'|'right'|'left'|'undocked';
}

export const DEFAULT_DEVTOOLS_SETTINGS: DevtoolsSettings = {
  enabledDevToolsExperiments: [],
  devToolsSettings: {
    isUnderTest: true,
  },
  dockingMode: 'right',
};

/**
 * @internal This should not be use outside setup
 */
async function setDevToolsSettings(devToolsPata: DevToolsPage, settings: Record<string, string|boolean>) {
  if (!Object.keys(settings).length) {
    return;
  }
  const rawValues = Object.entries(settings).map(value => {
    const rawValue = typeof value[1] === 'boolean' ? value[1].toString() : `'${value[1]}'`;
    return [value[0], rawValue];
  });

  return await devToolsPata.evaluate(`(async () => {
      const Common = await import('./core/common/common.js');
      ${rawValues.map(([settingName, value]) => {
    return `Common.Settings.Settings.instance().createSetting('${settingName}', ${value});`;
  })}
    })()`);
}

/**
 * @internal This should not be use outside setup
 */
async function setDevToolsExperiments(devToolsPage: DevToolsPage, experiments: string[]) {
  if (!experiments.length) {
    return;
  }
  return await devToolsPage.evaluate(async experiments => {
    // @ts-expect-error evaluate in DevTools page
    const Root = await import('./core/root/root.js');
    for (const experiment of experiments) {
      Root.Runtime.experiments.setEnabled(experiment, true);
    }
  }, experiments);
}

async function disableAnimations(devToolsPage: DevToolsPage) {
  const session = await devToolsPage.page.createCDPSession();
  await session.send('Animation.enable');
  await session.send('Animation.setPlaybackRate', {playbackRate: 30_000});
}

/**
 * @internal This should not be use outside setup
 */
async function setDockingSide(devToolsPage: DevToolsPage, side: string) {
  await devToolsPage.evaluate(`
    (async function() {
      const UI = await import('./ui/legacy/legacy.js');
      UI.DockController.DockController.instance().setDockSide('${side}');
    })();
  `);
}

export async function setupDevToolsPage(context: puppeteer.BrowserContext, settings: DevtoolsSettings) {
  const devToolsTarget = await context.waitForTarget(target => target.url().startsWith('devtools://'));
  const frontend = await devToolsTarget?.page();
  if (!frontend) {
    throw new Error('Unable to find frontend target!');
  }
  installPageErrorHandlers(frontend);
  const devToolsPage = new DevToolsPage(frontend);
  await devToolsPage.ensureReadyForTesting();
  await Promise.all([
    disableAnimations(devToolsPage),
    setDevToolsSettings(devToolsPage, settings.devToolsSettings),
    setDevToolsExperiments(devToolsPage, settings.enabledDevToolsExperiments),
  ]);

  await devToolsPage.reload();
  await devToolsPage.ensureReadyForTesting();

  await Promise.all([
    devToolsPage.throttleCPUIfRequired(),
    devToolsPage.delayPromisesIfRequired(),
    devToolsPage.useSoftMenu(),
  ]);

  await setDockingSide(devToolsPage, settings.dockingMode);
  return devToolsPage;
}

class HighlightedElement {
  constructor(readonly element: puppeteer.ElementHandle) {
  }

  async reset() {
    await this.element.evaluate(el => {
      if (el instanceof HTMLElement) {
        el.style.outline = '';
      }
    });
  }

  async highlight() {
    await this.element.evaluate(el => {
      if (el instanceof HTMLElement) {
        el.style.outline = '2px solid red';
      }
    });
  }
}
