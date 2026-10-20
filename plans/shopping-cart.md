# Shopping Cart Validation — Cross-Site Demo Test Plan

## Overview

Validates a two-item shopping cart flow (jeans + belt) including subtotal
calculation and guest checkout contact-information entry across two demo retail
sites. The test ends before order submission — payment fields are verified as
present and interactive but no order is placed.

**Target sites:**
- Tricentis Demo Web Shop (demowebshop.tricentis.com) — Blue Jeans $1.00, Casual Golf Belt $1.00
- NopCommerce Demo (demo.nopcommerce.com)

**Guest checkout:** Required — no login

## Contact and Shipping Data

```
email:    alex.tester@example.com
phone:    (555) 555-0123
first:    Alex
last:     Tester
street:   123 Example Street
city:     Springfield
state:    CA
zip:      90001
country:  United States
```

**Address format note:** Some sites split the address into separate Street / City /
State / Zip fields; others offer a single autocomplete field. The steps below are
written one field at a time so the runner can match whichever fields are present.

**State field note:** The State field may be a `<select>` dropdown or a free-text
input. The runner's `selectOption()` fallback chain tries "CA" as both value and
label, then partial-matches against "California".

**Country field note:** NopCommerce and similar platforms include a Country dropdown.
Select "United States" — this often re-renders the State dropdown to the US list.

## Test Scenarios

### 1. Add Items to Cart and Validate Subtotal

**Steps:**

1. Navigate to the retailer home page
   - expect: Home page is displayed and search functionality or category navigation is accessible

2. Enter "jeans" into the search field
   - expect: The search field accepts input
    - element: {"label":"Search products…","container":[],"neighbors":[],"tag":"input[text]"}

3. Click the search button
   - expect: Search results are displayed
   - expect: At least one jeans product is visible in the results
    - element: {"label":"Search","container":[],"neighbors":[],"tag":"input[submit]"}

4. Click "Add to cart" for the jeans product in the search results
    - element: {"label":"Add to cart","container":["Categories","Results for &ldquo;jeans&rdquo;"],"neighbors":[],"tag":"input[submit]"}

5. Click "Add to cart" on the product detail page if one opened instead of a direct add
   - after: [4]
   - expect: Cart count or confirmation indicator updates to reflect the added jeans
    - element: {"label":"Add to cart","container":["Categories","Results for &ldquo;jeans&rdquo;"],"neighbors":[],"tag":"input[submit]"}

6. Enter "belt" into the search field
   - expect: The search field accepts input
    - element: {"label":"Search products…","container":[],"neighbors":[],"tag":"input[text]"}

7. Click the search button
   - expect: Search results are displayed
   - expect: At least one belt product is visible in the results
    - element: {"label":"Search","container":[],"neighbors":[],"tag":"input[submit]"}

8. Click "Add to cart" for the belt product in the search results
    - element: {"label":"Add to cart","container":["Categories","Results for &ldquo;belt&rdquo;"],"neighbors":[],"tag":"input[submit]"}

9. Click "Add to cart" on the product detail page if one opened instead of a direct add
   - after: [8]
   - expect: The belt product has been added to the cart or the cart was updated
    - element: {"label":"Add to cart","container":["Categories","Results for &ldquo;belt&rdquo;"],"neighbors":[],"tag":"input[submit]"}

10. Click the shopping cart icon or link
    - expect: Cart page is displayed
    - expect: Two items are present in the cart
    - expect: Individual item prices are displayed for each item
    - element: {"label":"Cart","container":["© 2026 Demo Shop — for Pliant self-healing tests","Products ·"],"neighbors":["Products"],"tag":"a"}

11. Validate the cart subtotal calculation
    - expect: A subtotal or order total amount is displayed

    ```rules
    id: subtotal_validation
    formula: subtotal >= item_price
    tolerance: 0.01
    capture:
      - name: item_price
        semantic: "the unit price of one individual item shown in the cart table (a price per unit, not a row total or order total)"
        region: main
      - name: subtotal
        semantic: "the Sub-Total or Order Total dollar amount at the bottom of the cart summary, representing all items combined — look for a label like Sub-total, Order total, or Total"
        region: main
    ```

12. Check the "I agree with the terms of service" checkbox if it is present and unchecked
    - after: [10]
    - expect: The shopping cart page is displayed and a checkout option is visible
    - element: {"label":"I agree to the terms of service","container":["Shopping Cart","Order Summary","I agree to the terms of service"],"neighbors":["I agree to the terms of service"],"tag":"input[checkbox]"}

13. Click the checkout button or "Proceed to Checkout" link
    - after: [12]
    - expect: Checkout flow begins, or a login/guest-checkout selection page is presented
    - element: {"label":"Checkout","container":["Shopping Cart","Order Summary"],"neighbors":["Estimated Total\n        $124.00","I agree to the terms of service","Continue shopping"],"tag":"a"}

14. Click "Checkout as Guest" or "Guest Checkout" or select the guest radio button if presented
    - after: [13]
    - expect: Guest checkout billing address form or contact information fields are accessible
    - element: {"label":"Checkout as guest","container":["New Customer","Checkout and create account","Checkout as guest"],"neighbors":[],"tag":"input[radio]"}

15. Click "Continue" or "Next" to proceed past the guest selection step if a Continue button is present
    - after: [14]
    - expect: Billing address or contact information form is displayed
    - element: {"label":"Continue","container":["Checkout","New Customer"],"neighbors":["Checkout as guest"],"tag":"input[submit]"}

16. Enter "alex.tester@example.com" into the email address field
    - after: [13]
    - expect: Email address field is present and accepts input
    - element: {"label":"Email Address","container":["Billing Address","Enter Your Billing Address","Email Address"],"neighbors":["Email Address"],"tag":"input[email]"}

17. Enter "Alex" into the first name field, or "Alex Tester" into a combined full name field
    - after: [13]
    - expect: Name field is present and accepts input
    - element: {"label":"First name:","container":["Checkout","Billing address"],"neighbors":["First name:","*"],"tag":"input[text]"}

18. Enter "Tester" into the last name field
    - after: [17]
    - expect: Last name field is present and accepts input
    - element: {"label":"Last Name","container":["Billing Address","Enter Your Billing Address","Last Name"],"neighbors":["Last Name"],"tag":"input[text]"}

19. Enter "(555) 555-0123" into the phone number field
    - after: [13]
    - expect: Phone number field is present and accepts input
    - element: {"label":"Phone Number","container":["Billing Address","Enter Your Billing Address","Phone Number"],"neighbors":["Phone Number"],"tag":"input[tel]"}

20. Select "United States" for the country field if present
    - after: [13]
    - expect: Country field is present and accepts "United States"
    - element: {"label":"Country","container":["Billing Address","Enter Your Billing Address","Country"],"neighbors":["Country"],"tag":"select"}

21. Enter "123 Example Street" into the street address or Address 1 field
    - after: [13]
    - expect: Street address field is present and accepts input
    - element: {"label":"Street Address","container":["Billing Address","Enter Your Billing Address","Street Address"],"neighbors":["Street Address"],"tag":"input[text]"}

22. Enter "Springfield" into the city field
    - after: [21]
    - expect: City field is present and accepts input
    - element: {"label":"City:","container":["Checkout","Billing address"],"neighbors":["City:","*"],"tag":"input[text]"}

23. Enter "CA" into the state or province field
    - after: [20, 21]
    - expect: State or province field is present and accepts input
    - element: {"label":"State / Province","container":["Billing Address","Enter Your Billing Address","State / Province"],"neighbors":["State / Province"],"tag":"input[text]"}

24. Enter "90001" into the zip code or postal code field
    - after: [21]
    - expect: Zip code field is present and accepts input
    - element: {"label":"ZIP / Postal Code","container":["Billing Address","Enter Your Billing Address","ZIP / Postal Code"],"neighbors":["ZIP / Postal Code"],"tag":"input[text]"}

25. Click "Continue" to proceed past the billing address step
    - after: [17, 18, 20, 22, 24]
    - expect: The billing address has been submitted and the checkout is advancing — a shipping, payment, or next-step section is now visible or active
    - element: {"label":"Continue","container":["Billing Address","Enter Your Billing Address","Back"],"neighbors":["Back"],"tag":"input[submit]"}

26. Click Continue to advance past the shipping address step and reach the shipping method selection
    - after: [25]
    - expect: Shipping method options or radio buttons are displayed
    - element: {"label":"Continue","container":["Shipping Address","Back"],"neighbors":["Back"],"tag":"input[submit]"}

27. Click the first available shipping method radio button or option
    - after: [26]
    - expect: A shipping method is selected
    - element: {"label":"Standard Shipping 5–7 business days $4.99","container":["Shipping Method","Choose a Shipping Method"],"neighbors":["Standard Shipping\n            5–7 business days"],"tag":"input[radio]"}

28. Click the "Continue" button in the shipping method section to proceed to payment method selection
    - after: [27]
    - expect: Payment method options or credit card fields are displayed
    - element: {"label":"Continue","container":["Shipping Method","Choose a Shipping Method","Back"],"neighbors":["Back"],"tag":"input[submit]"}

29. Click the Credit Card payment method radio button to select credit card
    - after: [28]
    - expect: Credit card, PayPal, or other payment method options are visible on the page
    - element: {"label":"Credit / Debit Card","container":["Payment Method","Choose a Payment Method"],"neighbors":["💳"],"tag":"input[radio]"}

30. Click "Continue" in the payment method section to proceed to payment information
    - after: [29]
    - expect: Credit card number, expiry, and security code fields are present and interactive
    - stop: true
    - element: {"label":"Continue","container":["Payment Method","Choose a Payment Method","Back"],"neighbors":["Back"],"tag":"input[submit]"}
