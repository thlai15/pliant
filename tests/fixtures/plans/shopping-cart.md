# Shopping Cart Validation — Cross-Retailer Test Plan

## Overview

Validates a two-item shopping cart flow across retailers.

**Guest checkout:** Required — no login

### 1. Add Items to Cart and Validate Subtotal

**Steps:**

1. Navigate to the retailer home page
   - expect: Home page is displayed

2. Enter "jeans" into the search field
   - expect: The search field accepts input

3. Click the search button
   - expect: Search results are displayed
   - expect: At least one jeans product is visible in the results

4. Click "Add to cart" for the jeans product in the search results
   - expect: The jeans product is added to the cart

5. Click "Add to cart" on the product detail page if one opened instead of a direct add
   - expect: Cart count or confirmation indicator updates

6. Enter "belt" into the search field
   - expect: The search field accepts input

7. Click the search button
   - expect: Search results are displayed
   - expect: At least one belt product is visible in the results

8. Click "Add to cart" for the belt product in the search results
   - expect: The belt product is added to the cart

9. Validate the cart subtotal calculation
   - expect: A subtotal or order total amount is displayed

    ```rules
    id: subtotal_validation
    formula: subtotal == item_1_price + item_2_price
    tolerance: 0.01
    capture:
      - name: item_1_price
        semantic: "unit price of jeans item"
        region: main
      - name: item_2_price
        semantic: "unit price of belt item"
        region: main
      - name: subtotal
        semantic: "the cart sub-total or order total for all items combined"
        region: main
    ```

10. Click the checkout button or "Proceed to Checkout" link
    - after: [9]
    - expect: Checkout flow begins

11. Enter "test@example.com" into the email address field
    - after: [10]
    - expect: Email address field is present and accepts input

12. Enter "John" into the first name field
    - after: [10]
    - expect: Name field is present and accepts input

13. Click "Continue" to proceed past guest checkout
    - after: [10]
    - expect: Billing address or contact information form is displayed
    - stop: true
