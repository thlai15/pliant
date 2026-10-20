import { test, expect } from '@playwright/test'
import { matchElementPrompt } from '@llm/prompts/matchElement'
import { ElementHint } from '@types-local/index'
import { fakeElement } from '@fixtures/FakeDriver'

// Regression: on the Tricentis cart page a hint recorded on another site made the
// prompt nominate the unlabelled "Remove" checkbox instead of the terms checkbox.
const removeCheckbox = fakeElement({
  index: 16, tag: 'input', inputType: 'checkbox', selector: '#remove', label: '', text: '',
  path: 'Shopping cart > Remove:',
})
const termsCheckbox = fakeElement({
  index: 32, tag: 'input', inputType: 'checkbox', selector: '#termsofservice',
  label: 'I agree with the terms of service and I adhere to them unconditionally',
  path: 'Shopping cart > I agree with the terms of service and I adhere to them unconditionally',
})

const otherSiteHint: ElementHint = {
  label: 'I agree to the terms of service',
  container: ['Shopping Cart', 'Order Summary', 'I agree to the terms of service'],
  neighbors: [],
  tag: 'input[checkbox]',
}

const INTENT = 'Check the "I agree with the terms of service" checkbox if it is present and unchecked'

test('an unlabelled element is never nominated as the hint match', () => {
  const { prompt } = matchElementPrompt(INTENT, [removeCheckbox, termsCheckbox], otherSiteHint)
  expect(prompt.user).not.toContain('Return 16')
  expect(prompt.user).not.toContain('Best match for this hint: index 16')
})

test('a container-only match is not nominated as the best match', () => {
  const { prompt } = matchElementPrompt(INTENT, [removeCheckbox, termsCheckbox], otherSiteHint)
  expect(prompt.user).not.toContain('Best match for this hint')
  expect(prompt.user).toContain('Priority hint (from prior run)')
})

test('a label match is still nominated', () => {
  const sameSiteHint: ElementHint = { ...otherSiteHint, label: termsCheckbox.label ?? '' }
  const { prompt } = matchElementPrompt(INTENT, [removeCheckbox, termsCheckbox], sameSiteHint)
  expect(prompt.user).toContain('Best match for this hint: index 32')
})
