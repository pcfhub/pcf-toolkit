/*
 * The view the dev harness binds: columns and records, chosen for the edges.
 *
 * **This is not `demo/records.json`, and the difference is deliberate.** That
 * one is the hub's demo fixture — it exists to look like a working control on a
 * public page, so it is tidy, short and fits on one screen. This one exists to
 * break things:
 *
 *   - **twelve records**, so a page size of five gives three pages. The single
 *     page the hub's harness supplies is why every dataset control in the
 *     catalogue is stuck at `fidelity: "limited"`, and it is the reason paging
 *     code has never been exercised anywhere before this file.
 *   - **a hidden column and columns out of order**, because `isHidden` and
 *     `order` are the maker's decisions in the view designer and a table that
 *     ignores either looks broken to whoever set them.
 *   - **a non-sortable column**, which a real view has and a hand-written
 *     fixture never does.
 *   - **a null value and an empty string in the same column**, the two that
 *     catch a cell renderer treating falsy as empty.
 *   - **a name long enough to overflow**, because column widths are decided by
 *     `visualSizeFactor` and nobody finds out until a customer has a long one.
 *
 * Loaded by `harness.html` in a browser and by `smoke.js` in Node, so it
 * assigns both ways and depends on neither.
 */

(function (root, factory) {
    'use strict';

    var fixture = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = fixture;
    }

    if (root) {
        root.__pcfFixture = fixture;
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    return {
        targetEntityType: 'account',
        title: 'Active Accounts',

        /*
         * `order` is not the array order, on purpose: a view's columns arrive
         * in whatever order the platform hands them over and carry their
         * intended position in `order`. A control that renders them as supplied
         * looks correct against a fixture that agrees with itself and wrong
         * against a real view.
         */
        columns: [
            {
                name: 'accountnumber',
                displayName: 'Account number',
                dataType: 'SingleLine.Text',
                alias: 'accountnumber',
                order: 1,
                visualSizeFactor: 120,
            },
            {
                name: 'name',
                displayName: 'Account name',
                dataType: 'SingleLine.Text',
                alias: 'name',
                order: 0,
                visualSizeFactor: 200,
                isPrimary: true,
            },
            {
                name: 'statecode',
                displayName: 'Status',
                dataType: 'OptionSet',
                alias: 'statecode',
                order: 3,
                visualSizeFactor: 90,
            },
            {
                name: 'primarycontactname',
                displayName: 'Primary contact',
                dataType: 'SingleLine.Text',
                alias: 'primarycontactname',
                order: 2,
                visualSizeFactor: 150,
                // A computed or joined column a view can carry and a user
                // cannot order by. Its absence from a fixture is why a control
                // that renders every header as a sort button ships that way.
                disableSorting: true,
            },
            {
                /*
                 * The column this control exists for, and it carries the values
                 * a fixture normally leaves out: a hostile scheme, a bare
                 * hostname that is not a URL, an empty string and a null. The
                 * allow-list in shared/url.ts is a security boundary, and a
                 * fixture holding only well-formed https rows tests none of it.
                 */
                name: 'websiteurl',
                displayName: 'Website',
                dataType: 'SingleLine.URL',
                alias: 'websiteurl',
                order: 5,
                visualSizeFactor: 180,
            },
            {
                name: 'ownerid',
                displayName: 'Owner',
                dataType: 'Lookup.Simple',
                alias: 'ownerid',
                order: 4,
                visualSizeFactor: 120,
                // Present in the view and not to be drawn. A table that ignores
                // this shows a column the maker deliberately turned off.
                isHidden: true,
            },
        ],

        records: [
            { id: 'a01', values: { websiteurl: "https://www.fabrikam.example.com/about", name: 'Fabrikam Manufacturing', accountnumber: 'ACC-1042', primarycontactname: 'Dana Whitfield', statecode: 'Active', ownerid: 'Sam Vaziri' } },
            { id: 'a02', values: { websiteurl: "https://contoso.example.com", name: 'Contoso Logistics', accountnumber: 'ACC-1087', primarycontactname: 'Ravi Menon', statecode: 'Active', ownerid: 'Sam Vaziri' } },
            { id: 'a03', values: { websiteurl: "http://northwind.example.com/traders", name: 'Northwind Traders', accountnumber: 'ACC-1103', primarycontactname: 'Erin Boyle', statecode: 'Active', ownerid: 'Jo Park' } },
            { id: 'a04', values: { websiteurl: "javascript:alert(document.cookie)", name: 'Adventure Works Cycles', accountnumber: 'ACC-1155', primarycontactname: 'Marcus Feld', statecode: 'Active', ownerid: 'Jo Park' } },
            { id: 'a05', values: { websiteurl: "litware.example.com", name: 'Litware Consulting', accountnumber: 'ACC-1178', primarycontactname: 'Priya Raman', statecode: 'Inactive', ownerid: 'Jo Park' } },
            { id: 'a06', values: { websiteurl: "https://tailspin.example.com/toys?ref=crm&utm_source=view", name: 'Tailspin Toys', accountnumber: 'ACC-1201', primarycontactname: 'Owen Brackett', statecode: 'Active', ownerid: 'Sam Vaziri' } },
            { id: 'a07', values: { websiteurl: "", name: 'Proseware Systems', accountnumber: 'ACC-1233', primarycontactname: 'Alice Nakamura', statecode: 'Active', ownerid: 'Jo Park' } },
            { id: 'a08', values: { websiteurl: "https://wingtip.example.com", name: 'Wingtip Analytics', accountnumber: 'ACC-1260', primarycontactname: 'Tomas Ehrlich', statecode: 'Active', ownerid: 'Sam Vaziri' } },

            // The edges start here.

            // A column with no value at all, which is not the same as one with
            // an empty string — and both reach `getFormattedValue`.
            { id: 'a09', values: { websiteurl: null, name: 'Blue Yonder Airlines', accountnumber: null, primarycontactname: '', statecode: 'Active', ownerid: 'Jo Park' } },

            // Long enough to overflow whatever width `visualSizeFactor` bought.
            { id: 'a10', values: { websiteurl: "https://consolidated.example.com", name: 'Consolidated Messenger Intercontinental Freight and Warehousing', accountnumber: 'ACC-1288', primarycontactname: 'Margarethe Kowalczyk-Fitzgerald', statecode: 'Active', ownerid: 'Sam Vaziri' } },

            // Leading punctuation and a lowercase start: the two that show a
            // sort comparing raw strings rather than formatted values.
            { id: 'a11', values: { websiteurl: "data:text/html,<script>alert(1)</script>", name: '(pending) Woodgrove Bank', accountnumber: 'ACC-0007', primarycontactname: 'Ines Duarte', statecode: 'Inactive', ownerid: 'Jo Park' } },
            { id: 'a12', values: { websiteurl: "https://ecole.example.fr", name: 'école Numérique', accountnumber: 'ACC-1310', primarycontactname: 'LucRousseau', statecode: 'Active', ownerid: 'Sam Vaziri' } },
        ],
    };
});
