// The form canvas in the app's look: Formdown UI takes its colors, type and spacing from
// `--formdown-*` properties, set here from the app's tokens. The tokens follow the light and dark
// schemes, so the canvas does too. Set on the element, as outer styles win over its own defaults.

import { css, unsafeCSS } from 'lit'
import { strings } from './strings.js'

export const formdownTheme = css`
  formdown-ui {
    --formdown-bg-primary: var(--dc-color-bg);
    --formdown-bg-secondary: var(--dc-color-surface);
    --formdown-text-primary: var(--dc-color-text);
    --formdown-text-secondary: var(--dc-color-text-secondary);
    --formdown-border-color: var(--dc-color-border);
    /* A field's outline is a control's, 3:1 on the form's grounds; sections and tables keep the faint line. */
    --formdown-input-border-color: var(--dc-color-border-control);
    --formdown-accent-color: var(--dc-color-accent);
    --formdown-error-color: var(--dc-color-danger);
    --formdown-success-color: var(--dc-color-success);
    --formdown-warning-color: var(--dc-color-warning);

    /* Sizes stay Formdown's own, in rem, so the canvas reads at the size of the text around it. */
    --formdown-font-family: var(--dc-font-family);
    --formdown-font-weight-normal: var(--dc-font-weight-normal);
    --formdown-font-weight-medium: var(--dc-font-weight-medium);
    --formdown-font-weight-semibold: var(--dc-font-weight-semibold);

    --formdown-spacing-xs: var(--dc-space-1);
    --formdown-spacing-sm: var(--dc-space-2);
    --formdown-spacing-md: var(--dc-space-4);
    --formdown-spacing-lg: var(--dc-space-5);
    --formdown-spacing-xl: var(--dc-space-6);
    --formdown-field-gap: var(--dc-space-4);
    --formdown-label-margin: var(--dc-space-1);

    --formdown-input-padding: var(--dc-space-2);
    --formdown-input-padding-x: var(--dc-space-2);
    --formdown-input-padding-y: var(--dc-space-1);
    --formdown-input-border-radius: var(--dc-radius-sm);
    --formdown-input-focus-ring-width: var(--dc-focus-ring-width);
    --formdown-input-focus-ring-color: color-mix(in srgb, var(--dc-color-accent) 35%, transparent);

    --formdown-section-border-radius: var(--dc-radius-md);
    --formdown-section-padding: var(--dc-space-3);
    --formdown-table-border-radius: var(--dc-radius-md);
    --formdown-code-border-radius: var(--dc-radius-sm);

    /* The canvas's own buttons, when a form has any: flat, like the app's. */
    --formdown-button-bg: var(--dc-color-accent);
    --formdown-button-bg-hover: var(--dc-color-accent);
    --formdown-button-text: var(--dc-color-accent-contrast);
    --formdown-button-border-radius: var(--dc-radius-sm);
    --formdown-button-padding-x: var(--dc-space-3);
    --formdown-button-padding-y: var(--dc-space-2);
    --formdown-button-shadow: none;
    --formdown-button-shadow-hover: none;
    --formdown-button-secondary-bg: var(--dc-color-surface);
    --formdown-button-secondary-bg-hover: var(--dc-color-surface-hover);
    --formdown-button-danger-bg: var(--dc-color-danger);
    --formdown-button-danger-bg-hover: var(--dc-color-danger);
  }

  /* A value a date or number field could not take is shown beside it as written; say where it comes from. */
  formdown-ui::part(unread-value)::before {
    content: ${unsafeCSS(JSON.stringify(strings.unreadValue))};
    color: var(--dc-color-text-secondary);
    display: inline-block; /* keeps the value's underline off it */
    margin-right: var(--dc-space-1);
  }
`
