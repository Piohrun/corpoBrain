# Organization mapping

The Organization page keeps three independent relationships visible:

- Membership: Department → Product Area → POD → primary members. A support or management POD may sit directly below the Department.
- Reporting: each person has a Functional Manager and an Entity Manager. Both chains may contain any number of levels. Country Leads can report to Region Leads using the same Entity Manager field.
- Leadership: an organization note names its leads. Being a lead does not automatically make someone every member's manager or change their primary POD.

People can have one primary POD and any number of secondary memberships. Headcounts and the country matrix use primary memberships and any recorded unnamed remainder so each person is counted once. Country and region describe location; `country_lead_for` and `region_lead_for` describe responsibility, independently of where a lead is based.

## Using the feature

Open **Workspace → Organization** (`g r`). Create the Department, then its Product Areas and PODs with **+ Organization note**. For Cash Equities, create support PODs with the Department as their parent and choose **Support / management** in their details.

Select a person or organization to inspect it, compare both reporting chains, preview the linked note, or **Edit relationships**. Leadership can be assigned from either the person or group editor; both edit the group's authoritative `leads` property. Existing person notes also have an **Organization & reporting** editor in Note details. Location and role remain editable through the existing person properties.

- **Structure** shows expandable organizational groups, leads, mandates, and members. Secondary memberships have dashed borders and explicit labels.
- **Reporting** switches between Functional and Entity chains. Country and Department filters preserve managers above matches as context. Focus on one person's team to narrow the tree.
- **Matrix** compares primary POD membership across countries. Select a cell to inspect its people.

Finder (`Ctrl+K`) locates people and groups and opens their relationships or note previews. People without a primary POD stay visible in an unassigned section. A missing manager starts a separate reporting branch; it is not assumed to mean that person is a top-level leader.

## POD sizes without individual notes

Select a POD in Structure or Matrix, then choose **Edit POD size & reporting** in its inspector. Set **Total POD size** and click **Save POD size & reporting** directly below it. This is the total number of active primary members, including people already named. A POD of 20 with 3 named members displays **3 named + 17 others · 20 total**. Adding a fourth named primary member changes that to **4 + 16**, keeping the total at 20. Clearing the size returns to named people only. Secondary memberships never increase headcount.

Product Areas and Departments sum their PODs automatically, including support PODs. A POD lead is counted as a member only if that person has the POD as their primary membership. Inactive notes do not consume the unnamed remainder; **Include inactive** adds them to displayed named totals explicitly.

Other employees report to the POD's lead(s) by default. Set separate **Functional manager for others** and **Entity manager for others** overrides when needed. **Assigned managers only** disables the lead fallback. A POD with several leads shares the same unnamed group across those leads; it does not multiply the group size. Named people always use their own manager links.

For a cross-country POD, expand **Split other employees**. Add disjoint counted groups with a count, optional country, and optional Functional/Entity manager. Blank managers use the POD default. Any remaining unnamed people use the POD defaults and have an unknown country. The country matrix includes these groups and puts unknown countries in **Not set**, without inferring location from a manager. Each person represented by a counted group belongs to just that one group.

The editor rejects negative/fractional sizes, a size below active named membership, and allocations exceeding the available unnamed people. If later raw edits or new named members make allocations inconsistent, sizes still reflect known people and reporting attribution pauses until the groups are corrected. Such issues appear in **relationship issues**.

## Reporting counts

Every person has **Functional**, **Entity**, and **Both** counts in their inspector, with direct and total reports (all levels). Counts exclude the selected manager. Selecting a count focuses that reporting view. The Reporting view also offers **Both · unique people**, a table for inspecting the combined structure without duplicating a person across two branches.

**Both follows either type of reporting link at every level**, including mixed paths. For example, if A reports functionally to B, and B reports locally to C, A is included in C's Both total. A person reached by multiple paths is counted once. The same applies to a counted group reached through several leads or both manager chains. Direct reports use one edge; indirect reports are the remaining unique people. Cycles from external edits terminate safely and never make a manager count themselves.

Display filters and collapsed branches do not shrink a manager's reporting total. Inactive intermediate managers can still connect active reports upward. Unnamed people without a manager remain in POD size totals, with an explicit notice that they are absent from reporting totals. A missing manager is never guessed from group membership for named people.

## Plain Markdown contract

Person properties are additive. Existing `team`, `region`, `country`, capacity, and note-tree `parent` behavior is unchanged. Membership and reporting never rewrite a person's note-tree parent.

```yaml
type: person
title: Anna Kowalska
country: PL
region: EMEA
functional_manager: "[[people/maya]]"
entity_manager: "[[people/grace]]"
primary_pod: "[[organization/execution]]"
secondary_pods: ["[[organization/connectivity]]"]
country_lead_for: []
region_lead_for: []
```

Groups are notes under `folders.organization` (default `organization/`). Use `type: org_unit` and `org_kind: department | product_area | pod`:

```yaml
type: org_unit
title: Execution Services
org_kind: pod
parent: "[[organization/trading-technology]]"
leads: ["[[people/anna]]"]
pod_kind: product
status: active
mandate: Build and operate the order execution workflow.
```

Optional POD size and reporting properties:

```yaml
headcount: 20
headcount_reporting: pod_leads
headcount_functional_manager: "[[people/maya]]"
headcount_entity_manager: "[[people/grace]]"
headcount_groups:
  - id: india-team
    count: 8
    country: India
    entity_manager: "[[people/amit]]"
```

`headcount_reporting` is `pod_leads` (default) or `explicit`. Each group has a stable unique `id` within its POD and a positive whole-number `count`. Group managers override POD defaults. Country is optional; no placeholder person notes are created. These fields belong only on POD notes.

Group bodies hold arbitrary responsibilities, products, meeting notes, and wikilinks. Custom frontmatter is supported by the normal note editor. `pod_kind` is `product` or `support`. Multiple leads are allowed. Department parents are empty; Product Areas can have Department parents; PODs can have Product Area or Department parents. Unplaced groups are permitted while mapping an incomplete organization.

The built-in person template stays minimal. Relationship fields are added when you set them. An existing custom `templates/person.md` remains authoritative and is never replaced; the relationship editor works without adding keys to that template first.

Organization views are derived from the existing note index. No new canonical database or migration is needed. References resolve among the allowed note types, by full path first, then unique title/alias, then unique filename: `[[execution]]` and `[[alex]]` work without a folder prefix. An unrelated note with the same title does not make a person or POD reference ambiguous. Full-path wikilinks disambiguate duplicate names. App moves and renames of people and organization notes preserve their old paths as aliases, retaining relationships and backlinks. Region and team hub moves do not add path aliases. An exact path takes precedence over an alias, so reusing an old path can redirect references; update those links before reusing it. Direct filesystem renames still require preserving an alias or updating the links, as with other notes.

The relationship API validates reference types, parent kinds, and each reporting chain independently before writing a file. Dedicated organization fields are excluded from generic category inputs. Dragging an organization note in the notes tree or changing its Parent note uses the same parent-kind and cycle checks, so the notes tree can mirror the organization hierarchy. Circular chains and missing or ambiguous references introduced through the raw Markdown editor appear as relationship issues; the map remains navigable. Clearing a relation removes that property. Inactive people are hidden by default but can be included; filtered managers remain available as reporting context.

## Importing from Teambook

PODs, people and memberships can be proposed from Teambook and applied after review; see [Teambook org import](TEAMBOOK.md). Imported notes carry `teambook_id`; the importer only fills, updates or adds to the relationship fields above under three-way-merge rules, so values you edit by hand stay yours.

## Design references

[ChartHop custom groups](https://docs.charthop.com/custom-groups) separates nested product groups and membership from traditional reporting lines. [ChartHop's org chart](https://docs.charthop.com/org-chart) informed expandable branches, focused team views, and profile inspection.

[Orgvue's organization analysis](https://www.orgvue.com/solutions/organization-analysis/) uses multiple visual perspectives to examine the same organization. Here, the structure, reporting, and matrix views answer different questions over the same notes. [Organimi](https://www.organimi.com/cloud-based-org-charts/) is another reference for supporting traditional and matrix structures with custom metadata.

This first version emphasizes explicit relationships and readable drill-down. A free-positioned canvas, effective-date history, scenario planning, and capacity allocation across secondary memberships are future extensions; no secondary membership implies an allocation percentage.
