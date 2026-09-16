# Sheet visibility in shared applications

Qlik creates new sheets privately for the authenticated Qlik principal. With confidential
OAuth, that principal is the backend integration user. A successful Engine readback therefore
does not establish that a person signed into the browser can see the sheet.

Use an explicit `sheet.publish` step after creating and verifying a sheet and its charts.
In a shared space, public sheets become visible to users who already have access to the app
or the required space permissions. Publication does not grant space membership or move the
application. See [Qlik's sheet visibility documentation](https://help.qlik.com/en-US/cloud-services/Subsystems/Hub/Content/Sense_Hub/Share/make-public-or-private.htm).

## Governed actions

| Action            | Required input in addition to `connection` and `appId` | Result                                                                                      |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `sheet.get`       | `sheetId`                                              | Current content hash and `published`/`approved` metadata. Unknown metadata is `null`.       |
| `sheet.publish`   | `sheetId`, `expectedHash`                              | Publishes that exact sheet and verifies `published: true`.                                  |
| `sheet.unpublish` | `sheetId`, `expectedHash`                              | Makes the sheet private and verifies `published: false`. Approved base content is rejected. |

Both mutations require an exact authorized app target, the standard immutable workflow,
any required separate approval, and the latest sheet content hash. They call the supported
QIX generic-object `publish()` or `unPublish()` operation and verify visibility using a fresh
Engine session. There is no automatic publication in `sheet.create`, `sheet.duplicate`, or
chart creation.

Read the sheet again immediately before planning publication. Adding or editing a chart
changes the sheet snapshot, so a hash captured before those edits is stale. The content hash
guards the sheet and displayed objects; `published` and `approved` are separately verified
provider metadata and publication alone may leave the content hash unchanged.

An already matching visibility state returns verified readback without a redundant native
publication call. Unknown publication metadata fails closed. An acknowledgement without
matching readback remains uncertain and follows the existing
[recovery procedure](management-recovery.md).

## Acceptance evidence

The core management acceptance runner explicitly publishes its newly created fixture sheet
after verifying its chart values, then checks `sheet.get.published === true` before exporting
the app. The extended lifecycle helper keeps its temporary sheets private and deletes only
its own verified child resources.

The final user-facing check is a separate authenticated browser session: open the exact app
and sheet URL as the intended viewer, and confirm the expected chart values render. Provider
publication metadata and a rendered browser sheet are distinct pieces of evidence.

In managed spaces, published community content and approved base content have different
rules. This API does not remove approval from base sheets to make them private. Such a change
requires the applicable Qlik publishing workflow and permissions.
