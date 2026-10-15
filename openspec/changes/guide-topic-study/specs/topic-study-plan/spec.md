# Spec Delta

## Purpose

Turn one learning goal, written in the existing assistant, into an ordered notebook plan whose pages are ingested into the library only after the user confirms.

## ADDED Requirements

### Requirement: The assistant proposes an editable plan in chat
An authenticated user with chat enabled SHALL be able to ask the existing assistant for a plan by sending a goal of 1 to 200 characters. The assistant SHALL answer with a structured plan card in that same chat. The card SHALL contain 4 to 8 modules. Each module SHALL have a title of 1 to 120 characters, an outcome of 1 to 400 characters, prerequisites that refer only to earlier modules in that card, and 0 to 4 http(s) URLs. The user SHALL be able to change the card by sending another message, and the assistant SHALL answer with a replacement card. A replacement card that the user fully specified SHALL NOT require another model completion. The completion that proposes a card from a goal SHALL treat the goal as data and SHALL name the requested locale for titles and outcomes. Locale SHALL be `en` or `ru`, default `en`. The proposal SHALL NOT create a notebook, plan, source, or card. Before a card is shown, each suggested URL SHALL be checked with HEAD, then with GET when HEAD is not a success, through the existing page fetch and its SSRF guards. A URL that those guards reject, or that does not return a success status, SHALL be dropped. A module MAY be shown with no URLs. The check SHALL NOT insert a source. Chat disabled SHALL NOT call the model and SHALL NOT create a notebook or plan.

#### Scenario: Goal in the assistant
- **WHEN** chat is enabled and the user asks the assistant to learn a non-empty topic
- **THEN** the chat shows an ordered plan card and the account's notebooks, sources, and cards are unchanged

#### Scenario: Revision in words
- **WHEN** the user sends a later message that changes the proposed modules or URLs
- **THEN** the chat shows a replacement plan card and still creates no notebook, plan, source, or card

#### Scenario: Russian proposal
- **WHEN** the proposal locale is `ru`
- **THEN** the completion request instructs the model to write titles and outcomes in Russian

#### Scenario: Dead suggested URL
- **WHEN** the model suggests one URL that answers successfully and one URL that does not
- **THEN** the card contains only the successful URL and no source is created

#### Scenario: Private suggested URL
- **WHEN** the model suggests a URL the page fetch rejects as private
- **THEN** that URL is absent from the card

#### Scenario: Invalid model output
- **WHEN** the model output does not satisfy the card bounds
- **THEN** the proposal fails and no notebook, plan, source, or card is written

#### Scenario: Chat is off
- **WHEN** chat is disabled and the user asks for a plan
- **THEN** the assistant does not call the model and writes no notebook or plan

#### Scenario: Repeated proposal of the same goal
- **WHEN** chat is enabled, the AI cooldown is enabled, and the same user requests another model proposal for a plan within 30 seconds
- **THEN** the response is a cooldown error and the model is not called again

### Requirement: A confirmed plan stays inside the module bounds
The plan the user confirms SHALL contain 1 to 12 modules. The goal SHALL be 1 to 200 characters. The level SHALL be omitted or 1 to 80 characters. Each module SHALL use the same title, outcome, prerequisite, and URL bounds as a proposal card. Modules with no URLs SHALL be valid. A plan outside those bounds SHALL be rejected and SHALL NOT write. Applying a valid plan SHALL NOT call the model. Chat being disabled SHALL NOT block applying a valid plan that was already proposed.

#### Scenario: Apply does not call the model
- **WHEN** the user confirms one valid module and chat completion is unavailable for that apply
- **THEN** the plan is stored and no model call is made

#### Scenario: Too many modules
- **WHEN** the user confirms 13 modules
- **THEN** the response is rejected and no plan is written

#### Scenario: Prerequisite points forward
- **WHEN** the user confirms a module whose prerequisite is itself or a later module
- **THEN** the response is rejected and no plan is written

### Requirement: Confirmation creates one notebook plan
The confirmed apply SHALL create one owned notebook and exactly one plan in the same successful result. That new notebook's title SHALL come from the goal. A later save SHALL NOT rename the notebook. A notebook SHALL hold at most one plan. A later save SHALL replace the goal, level, and module list. A module whose existing id is included SHALL keep its source links. A module omitted from the save SHALL lose its links. Omitted modules SHALL NOT delete library sources or notebook memberships. A save SHALL NOT create cards. After a successful confirmation the client SHALL open that notebook's plan. Rejecting the confirmation SHALL write no notebook, plan, source, or card.

#### Scenario: Confirm
- **WHEN** the user confirms a valid plan card and does not name an existing notebook
- **THEN** one new notebook and one plan exist, and the client is sent to that notebook's plan

#### Scenario: Reject
- **WHEN** the user rejects the plan card
- **THEN** no notebook, plan, source, or card is written

#### Scenario: Second save keeps a module
- **WHEN** the user saves again and includes an existing module id
- **THEN** that module remains and its previously linked sources stay linked

#### Scenario: Second save drops a module
- **WHEN** the user saves again and omits a module that had a linked source
- **THEN** the module and its link are gone, and the library source and notebook membership remain

#### Scenario: Second plan for one notebook
- **WHEN** the user saves a new plan onto a notebook that already has a plan
- **THEN** the request is rejected and the stored plan is unchanged

#### Scenario: Foreign notebook
- **WHEN** the user saves a plan onto another user's notebook
- **THEN** the response is not found and no plan is written

### Requirement: Confirmation ingests accepted URLs
Confirming a plan SHALL add the card's URLs for each owned module, in order, through the existing URL ingest. Each URL SHALL be normalized by trimming, requiring `http` or `https`, rejecting userinfo, lowercasing the scheme and host, and removing the fragment. For a matching owned URL source that is not deleting, the action SHALL link that source and attach it to the notebook when it is not already attached, and SHALL NOT insert another source. Otherwise the action SHALL create one URL library item through the existing ingest path, so the page text is stored, and SHALL link it to the module and attach it to the notebook. The action SHALL stop before a library cap or a notebook source cap would be exceeded. URLs already processed in that confirmation SHALL remain. The response SHALL identify each URL as linked, created, or rejected with a machine code. A later ingest failure SHALL remain the source's existing error state and SHALL NOT remove the module link. The action SHALL NOT create cards and SHALL NOT fetch the URL before the source row exists.

#### Scenario: Reuse an owned page
- **WHEN** the user confirms a URL that matches an owned URL source that is not deleting
- **THEN** no additional source row is created, the source is attached to the plan's notebook, and the module lists it

#### Scenario: New page is ingested
- **WHEN** the user confirms a new http(s) URL and both caps allow it
- **THEN** one URL source is created, existing URL ingest stores the page text, the source is attached to the notebook, and the module lists that source

#### Scenario: Cap stops the rest of the batch
- **WHEN** the next URL in the confirmation would exceed the library cap or the notebook source cap
- **THEN** that URL and the URLs after it are not created, earlier URLs from the same confirmation remain, and the response names the cap code

#### Scenario: Fetch fails after confirm
- **WHEN** a confirmed URL later fails ingest
- **THEN** the source shows the existing ingest error and the module still lists it

### Requirement: Plan status is derived and opens the reader
A notebook with a plan SHALL be able to show that plan on a tab. A module with no linked sources SHALL be empty. A module whose linked sources are still in a non-terminal ingest state SHALL be ingesting. A module with at least one source the existing reader can open SHALL be readable. The plan tab SHALL open that source in the existing reader. Status SHALL NOT be stored as a separate completion flag, and the plan SHALL NOT mark a module mastered. The tab SHALL NOT be a second place to type the goal or the URLs.

#### Scenario: Page still parsing
- **WHEN** a linked source is still parsing
- **THEN** the module is shown as ingesting and is not shown as readable

#### Scenario: Open a readable page
- **WHEN** the user opens a linked source the reader can open
- **THEN** the existing reader opens that source and no card is created

### Requirement: Plans stay isolated and follow ownership
Reading or changing a plan SHALL require the owning user. The user id SHALL come from the session. Deleting the notebook SHALL delete the plan and its modules. Deleting a linked source SHALL remove that link and SHALL leave the plan and the other links in place. No plan route and no plan confirmation SHALL create, grade, suspend, or delete a card.

#### Scenario: Another user
- **WHEN** a different user reads the plan, saves modules, or confirms sources for it
- **THEN** the response is not found and no plan, source, or card is created for that user

#### Scenario: Delete the notebook
- **WHEN** the owner deletes the notebook
- **THEN** the plan and modules are deleted and the library sources remain

#### Scenario: Delete a linked source
- **WHEN** the owner deletes a source linked from a module
- **THEN** the module remains without that link
