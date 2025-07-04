/*
 * Copyright (C) 2013 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/* eslint-disable rulesdir/no-imperative-dom-api */

import './Toolbar.js';

import * as Common from '../../core/common/common.js';
import * as Host from '../../core/host/host.js';
import * as i18n from '../../core/i18n/i18n.js';
import * as Platform from '../../core/platform/platform.js';
import * as VisualLogging from '../../ui/visual_logging/visual_logging.js';

import * as ARIAUtils from './ARIAUtils.js';
import filterStyles from './filter.css.js';
import {KeyboardShortcut, Modifiers} from './KeyboardShortcut.js';
import {bindCheckbox} from './SettingsUI.js';
import type {Suggestions} from './SuggestBox.js';
import {type ToolbarButton, ToolbarFilter, ToolbarInput, ToolbarSettingToggle} from './Toolbar.js';
import {Tooltip} from './Tooltip.js';
import {CheckboxLabel, createTextChild} from './UIUtils.js';
import {HBox} from './Widget.js';

const UIStrings = {
  /**
   *@description Text to filter result items
   */
  filter: 'Filter',
  /**
   *@description Text that appears when hover over the filter bar in the Network tool
   */
  egSmalldUrlacomb: 'e.g. `/small[\d]+/ url:a.com/b`',
  /**
   *@description Text that appears when hover over the All button in the Network tool
   *@example {Ctrl + } PH1
   */
  sclickToSelectMultipleTypes: '{PH1}Click to select multiple types',
  /**
   *@description Text for everything
   */
  allStrings: 'All',
} as const;
const str_ = i18n.i18n.registerUIStrings('ui/legacy/FilterBar.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);
export class FilterBar extends Common.ObjectWrapper.eventMixin<FilterBarEventTypes, typeof HBox>(HBox) {
  private enabled: boolean;
  private readonly stateSetting: Common.Settings.Setting<boolean>;
  private readonly filterButtonInternal: ToolbarSettingToggle;
  private filters: FilterUI[];
  private alwaysShowFilters?: boolean;
  private showingWidget?: boolean;

  constructor(name: string, visibleByDefault?: boolean) {
    super();
    this.registerRequiredCSS(filterStyles);
    this.enabled = true;
    this.element.classList.add('filter-bar');
    this.element.setAttribute('jslog', `${VisualLogging.toolbar('filter-bar')}`);

    this.stateSetting =
        Common.Settings.Settings.instance().createSetting('filter-bar-' + name + '-toggled', Boolean(visibleByDefault));
    this.filterButtonInternal =
        new ToolbarSettingToggle(this.stateSetting, 'filter', i18nString(UIStrings.filter), 'filter-filled', 'filter');
    this.filterButtonInternal.element.style.setProperty('--dot-toggle-top', '13px');
    this.filterButtonInternal.element.style.setProperty('--dot-toggle-left', '14px');

    this.filters = [];

    this.updateFilterBar();
    this.stateSetting.addChangeListener(this.updateFilterBar.bind(this));
  }

  filterButton(): ToolbarButton {
    return this.filterButtonInternal;
  }

  addDivider(): void {
    const element = document.createElement('div');
    element.classList.add('filter-divider');
    this.element.appendChild(element);
  }

  addFilter(filter: FilterUI): void {
    this.filters.push(filter);
    this.element.appendChild(filter.element());
    filter.addEventListener(FilterUIEvents.FILTER_CHANGED, this.filterChanged, this);
    this.updateFilterButton();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.filterButtonInternal.setEnabled(enabled);
    this.updateFilterBar();
  }

  private filterChanged(): void {
    this.updateFilterButton();
    this.dispatchEventToListeners(FilterBarEvents.CHANGED);
  }

  override wasShown(): void {
    super.wasShown();
    this.updateFilterBar();
  }

  private updateFilterBar(): void {
    if (!this.parentWidget() || this.showingWidget) {
      return;
    }
    if (this.visible()) {
      this.showingWidget = true;
      this.showWidget();
      this.showingWidget = false;
    } else {
      this.hideWidget();
    }
  }

  override focus(): void {
    for (let i = 0; i < this.filters.length; ++i) {
      if (this.filters[i] instanceof TextFilterUI) {
        const textFilterUI = (this.filters[i] as TextFilterUI);
        textFilterUI.focus();
        break;
      }
    }
  }

  hasActiveFilter(): boolean {
    for (const filter of this.filters) {
      if (filter.isActive()) {
        return true;
      }
    }
    return false;
  }

  private updateFilterButton(): void {
    const isActive = this.hasActiveFilter();
    this.filterButtonInternal.setChecked(isActive);
  }

  clear(): void {
    this.element.removeChildren();
    this.filters = [];
    this.updateFilterButton();
  }

  setting(): Common.Settings.Setting<boolean> {
    return this.stateSetting;
  }

  visible(): boolean {
    return this.alwaysShowFilters || (this.stateSetting.get() && this.enabled);
  }
}

export const enum FilterBarEvents {
  CHANGED = 'Changed',
}

export interface FilterBarEventTypes {
  [FilterBarEvents.CHANGED]: void;
}

export interface FilterUI extends Common.EventTarget.EventTarget<FilterUIEventTypes> {
  isActive(): boolean;
  element(): Element;
}

export const enum FilterUIEvents {
  FILTER_CHANGED = 'FilterChanged',
}

export interface FilterUIEventTypes {
  [FilterUIEvents.FILTER_CHANGED]: void;
}

export class TextFilterUI extends Common.ObjectWrapper.ObjectWrapper<FilterUIEventTypes> implements FilterUI {
  private readonly filterElement: HTMLDivElement;
  #filter: ToolbarFilter;
  private suggestionProvider: ((arg0: string, arg1: string, arg2?: boolean|undefined) => Promise<Suggestions>)|null;
  constructor() {
    super();
    this.filterElement = document.createElement('div');
    this.filterElement.classList.add('text-filter');
    const filterToolbar = this.filterElement.createChild('devtools-toolbar');
    // Set the style directly on the element to overwrite parent css styling.
    filterToolbar.style.borderBottom = 'none';
    this.#filter =
        new ToolbarFilter(undefined, 1, 1, i18nString(UIStrings.egSmalldUrlacomb), this.completions.bind(this));
    filterToolbar.appendToolbarItem(this.#filter);
    this.#filter.addEventListener(ToolbarInput.Event.TEXT_CHANGED, () => this.valueChanged());
    this.suggestionProvider = null;
  }

  private completions(expression: string, prefix: string, force?: boolean): Promise<Suggestions> {
    if (this.suggestionProvider) {
      return this.suggestionProvider(expression, prefix, force);
    }
    return Promise.resolve([]);
  }

  isActive(): boolean {
    return Boolean(this.#filter.valueWithoutSuggestion());
  }

  element(): Element {
    return this.filterElement;
  }

  value(): string {
    return this.#filter.valueWithoutSuggestion();
  }

  setValue(value: string): void {
    this.#filter.setValue(value);
    this.valueChanged();
  }

  focus(): void {
    this.#filter.focus();
  }

  setSuggestionProvider(
      suggestionProvider: (arg0: string, arg1: string, arg2?: boolean|undefined) => Promise<Suggestions>): void {
    this.#filter.clearAutocomplete();
    this.suggestionProvider = suggestionProvider;
  }

  private valueChanged(): void {
    this.dispatchEventToListeners(FilterUIEvents.FILTER_CHANGED);
  }

  clear(): void {
    this.setValue('');
  }
}

interface NamedBitSetFilterUIOptions {
  items: Item[];
  setting?: Common.Settings.Setting<Record<string, boolean>>;
}

export class NamedBitSetFilterUIElement extends HTMLElement {
  #options: NamedBitSetFilterUIOptions = {items: []};
  readonly #shadow = this.attachShadow({mode: 'open'});
  #namedBitSetFilterUI?: NamedBitSetFilterUI;

  set options(options: NamedBitSetFilterUIOptions) {
    // return if they are the same
    if (this.#options.items.toString() === options.items.toString() && this.#options.setting === options.setting) {
      return;
    }

    this.#options = options;
    // When options are updated, clear the UI so that a new one is created with the new options
    this.#shadow.innerHTML = '';
    this.#namedBitSetFilterUI = undefined;
  }

  getOrCreateNamedBitSetFilterUI(): NamedBitSetFilterUI {
    if (this.#namedBitSetFilterUI) {
      return this.#namedBitSetFilterUI;
    }

    const namedBitSetFilterUI = new NamedBitSetFilterUI(this.#options.items, this.#options.setting);
    namedBitSetFilterUI.element().classList.add('named-bitset-filter');

    const styleElement = this.#shadow.createChild('style');
    styleElement.textContent = filterStyles;

    const disclosureElement = this.#shadow.createChild('div', 'named-bit-set-filter-disclosure');
    disclosureElement.appendChild(namedBitSetFilterUI.element());

    // Translate existing filter ("ObjectWrapper") events to DOM CustomEvents so clients can
    // use lit templates to bind listeners.
    namedBitSetFilterUI.addEventListener(FilterUIEvents.FILTER_CHANGED, this.#filterChanged.bind(this));

    this.#namedBitSetFilterUI = namedBitSetFilterUI;
    return this.#namedBitSetFilterUI;
  }

  #filterChanged(): void {
    const domEvent = new CustomEvent('filterChanged');
    this.dispatchEvent(domEvent);
  }
}

customElements.define('devtools-named-bit-set-filter', NamedBitSetFilterUIElement);

export class NamedBitSetFilterUI extends Common.ObjectWrapper.ObjectWrapper<FilterUIEventTypes> implements FilterUI {
  private readonly filtersElement: HTMLDivElement;
  private readonly typeFilterElementTypeNames = new WeakMap<HTMLElement, string>();
  private allowedTypes = new Set<string>();
  private readonly typeFilterElements: HTMLElement[] = [];
  private readonly setting: Common.Settings.Setting<Record<string, boolean>>|undefined;

  constructor(items: Item[], setting?: Common.Settings.Setting<Record<string, boolean>>) {
    super();
    this.filtersElement = document.createElement('div');
    this.filtersElement.classList.add('filter-bitset-filter');
    this.filtersElement.setAttribute('jslog', `${VisualLogging.section('filter-bitset')}`);
    ARIAUtils.markAsListBox(this.filtersElement);
    ARIAUtils.markAsMultiSelectable(this.filtersElement);
    Tooltip.install(this.filtersElement, i18nString(UIStrings.sclickToSelectMultipleTypes, {
                      PH1: KeyboardShortcut.shortcutToString('', Modifiers.CtrlOrMeta.value),
                    }));

    this.addBit(NamedBitSetFilterUI.ALL_TYPES, i18nString(UIStrings.allStrings), NamedBitSetFilterUI.ALL_TYPES);
    this.typeFilterElements[0].tabIndex = 0;
    this.filtersElement.createChild('div', 'filter-bitset-filter-divider');

    for (let i = 0; i < items.length; ++i) {
      this.addBit(items[i].name, items[i].label(), items[i].jslogContext, items[i].title);
    }

    if (setting) {
      this.setting = setting;
      setting.addChangeListener(this.settingChanged.bind(this));
      this.settingChanged();
    } else {
      this.toggleTypeFilter(NamedBitSetFilterUI.ALL_TYPES, false /* allowMultiSelect */);
    }
  }

  reset(): void {
    this.toggleTypeFilter(NamedBitSetFilterUI.ALL_TYPES, false /* allowMultiSelect */);
  }

  isActive(): boolean {
    return !this.allowedTypes.has(NamedBitSetFilterUI.ALL_TYPES);
  }

  element(): Element {
    return this.filtersElement;
  }

  accept(typeName: string): boolean {
    return this.allowedTypes.has(NamedBitSetFilterUI.ALL_TYPES) || this.allowedTypes.has(typeName);
  }

  private settingChanged(): void {
    const allowedTypesFromSetting = (this.setting as Common.Settings.Setting<Record<string, boolean>>).get();
    this.allowedTypes = new Set();
    for (const element of this.typeFilterElements) {
      const typeName = this.typeFilterElementTypeNames.get(element);
      if (typeName && allowedTypesFromSetting[typeName]) {
        this.allowedTypes.add(typeName);
      }
    }
    this.update();
  }

  private update(): void {
    if (this.allowedTypes.size === 0 || this.allowedTypes.has(NamedBitSetFilterUI.ALL_TYPES)) {
      this.allowedTypes = new Set();
      this.allowedTypes.add(NamedBitSetFilterUI.ALL_TYPES);
    }
    for (const element of this.typeFilterElements) {
      const typeName = this.typeFilterElementTypeNames.get(element);
      const active = this.allowedTypes.has(typeName || '');
      element.classList.toggle('selected', active);
      ARIAUtils.setSelected(element, active);
    }
    this.dispatchEventToListeners(FilterUIEvents.FILTER_CHANGED);
  }

  private addBit(name: string, label: string, jslogContext: string, title?: string): void {
    const typeFilterElement = this.filtersElement.createChild('span', name);
    typeFilterElement.tabIndex = -1;
    this.typeFilterElementTypeNames.set(typeFilterElement, name);
    createTextChild(typeFilterElement, label);
    ARIAUtils.markAsOption(typeFilterElement);
    if (title) {
      typeFilterElement.title = title;
    }
    typeFilterElement.addEventListener('click', this.onTypeFilterClicked.bind(this), false);
    typeFilterElement.addEventListener('keydown', this.onTypeFilterKeydown.bind(this), false);
    typeFilterElement.setAttribute('jslog', `${VisualLogging.item(jslogContext).track({click: true})}`);
    this.typeFilterElements.push(typeFilterElement);
  }

  private onTypeFilterClicked(event: Event): void {
    const e = (event as KeyboardEvent);
    let toggle;
    if (Host.Platform.isMac()) {
      toggle = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    } else {
      toggle = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    }
    if (e.target) {
      const element = (e.target as HTMLElement);
      const typeName = (this.typeFilterElementTypeNames.get(element) as string);
      this.toggleTypeFilter(typeName, toggle);
    }
  }

  private onTypeFilterKeydown(event: KeyboardEvent): void {
    const element = (event.target as HTMLElement | null);
    if (!element) {
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      if (this.keyFocusNextBit(element, true /* selectPrevious */)) {
        event.consume(true);
      }
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      if (this.keyFocusNextBit(element, false /* selectPrevious */)) {
        event.consume(true);
      }
    } else if (Platform.KeyboardUtilities.isEnterOrSpaceKey(event)) {
      this.onTypeFilterClicked(event);
    }
  }

  private keyFocusNextBit(target: HTMLElement, selectPrevious: boolean): boolean {
    let index = this.typeFilterElements.indexOf(target);

    if (index === -1) {
      index = this.typeFilterElements.findIndex(el => el.classList.contains('selected'));
      if (index === -1) {
        index = selectPrevious ? this.typeFilterElements.length : -1;
      }
    }

    const nextIndex = selectPrevious ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= this.typeFilterElements.length) {
      return false;
    }

    const nextElement = this.typeFilterElements[nextIndex];
    nextElement.tabIndex = 0;
    target.tabIndex = -1;
    nextElement.focus();
    return true;
  }

  private toggleTypeFilter(typeName: string, allowMultiSelect: boolean): void {
    if (allowMultiSelect && typeName !== NamedBitSetFilterUI.ALL_TYPES) {
      this.allowedTypes.delete(NamedBitSetFilterUI.ALL_TYPES);
    } else {
      this.allowedTypes = new Set();
    }

    if (this.allowedTypes.has(typeName)) {
      this.allowedTypes.delete(typeName);
    } else {
      this.allowedTypes.add(typeName);
    }

    if (this.allowedTypes.size === 0) {
      this.allowedTypes.add(NamedBitSetFilterUI.ALL_TYPES);
    }

    if (this.setting) {
      // Settings do not support `Sets` so convert it back to the Map-like object.
      const updatedSetting = ({} as Record<string, boolean>);
      for (const type of this.allowedTypes) {
        updatedSetting[type] = true;
      }
      this.setting.set(updatedSetting);
    } else {
      this.update();
    }
  }

  static readonly ALL_TYPES = 'all';
}

export class CheckboxFilterUI extends Common.ObjectWrapper.ObjectWrapper<FilterUIEventTypes> implements FilterUI {
  private readonly filterElement: HTMLDivElement;
  private readonly activeWhenChecked: boolean;
  private checkbox: CheckboxLabel;
  constructor(
      title: Common.UIString.LocalizedString,
      activeWhenChecked?: boolean,
      setting?: Common.Settings.Setting<boolean>,
      jslogContext?: string,
  ) {
    super();
    this.filterElement = document.createElement('div');
    this.filterElement.classList.add('filter-checkbox-filter');
    this.activeWhenChecked = Boolean(activeWhenChecked);
    this.checkbox = CheckboxLabel.create(title, undefined, undefined, jslogContext);
    this.filterElement.appendChild(this.checkbox);
    if (setting) {
      bindCheckbox(this.checkbox, setting);
    } else {
      this.checkbox.checked = true;
    }
    this.checkbox.addEventListener('change', this.fireUpdated.bind(this), false);
  }

  isActive(): boolean {
    return this.activeWhenChecked === this.checkbox.checked;
  }

  checked(): boolean {
    return this.checkbox.checked;
  }

  setChecked(checked: boolean): void {
    this.checkbox.checked = checked;
  }

  element(): HTMLDivElement {
    return this.filterElement;
  }

  labelElement(): Element {
    return this.checkbox;
  }

  private fireUpdated(): void {
    this.dispatchEventToListeners(FilterUIEvents.FILTER_CHANGED);
  }
}

export interface Item {
  name: string;
  label: () => string;
  title?: string;
  jslogContext: string;
}
