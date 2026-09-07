import { findCatalogueModel, requireCredential } from "../../ai/catalogue"
import { chatCapableClient } from "../../ai/clients"
import type { ProviderClient, ProviderCredential } from "../../ai/clients"
import { ValidationError } from "../../shared/errors"
import { modelService } from "../model/model.service"
import type { ModelSelection } from "../model/model.service"

/**
 * A client proven to accept a one-shot completion, in the type rather than at
 * every use — the same reason `ChatCapableClient` exists. Nothing here streams,
 * so what is needed is `chat`, not `streamChat`.
 */
export type CompletionClient = ProviderClient & Required<Pick<ProviderClient, "chat">>

export interface ResolvedModel {
	selection: ModelSelection
	client: CompletionClient
	credential: ProviderCredential
}

/**
 * The workspace's chat model, entitlement re-checked, with a client that can
 * actually be called.
 *
 * `resolveChatModel` re-checks entitlement itself; a selection that arrived with
 * the request has been checked by nobody, so it goes through `assertSelectable`
 * before it is used to spend anything.
 */
export async function resolveCompletionModel(
	workspaceId: string,
	requested?: ModelSelection,
): Promise<ResolvedModel> {
	const selection = requested ?? (await modelService.resolveChatModel(workspaceId))
	if (requested) await modelService.assertSelectable(workspaceId, requested, "chat")

	const client = chatCapableClient(selection.provider)
	if (!client?.chat) {
		throw new ValidationError(
			`This deployment cannot run chat with the ${selection.provider} provider.`,
			selection,
		)
	}

	return {
		selection,
		client: client as CompletionClient,
		credential: await requireCredential(selection.provider),
	}
}

/**
 * The same, plus the two gates that decide whether an image may be sent.
 *
 * `definition.vision` says the model itself reads images. `client.supportsVision`
 * says this deployment's adapter actually puts them on the wire — a gateway that
 * accepts a multi-part message and drops the image parts answers fluently about
 * a picture it never received, which is a failure nothing downstream can detect.
 */
export async function resolveVisionModel(
	workspaceId: string,
	requested?: ModelSelection,
): Promise<ResolvedModel> {
	const resolved = await resolveCompletionModel(workspaceId, requested)

	const definition = await findCatalogueModel(
		resolved.selection.provider,
		resolved.selection.model,
	)
	if (!definition?.vision) {
		throw new ValidationError(`${resolved.selection.model} cannot read images.`, resolved.selection)
	}

	if (!resolved.client.supportsVision) {
		throw new ValidationError(
			`This deployment cannot send images to the ${resolved.selection.provider} provider.`,
			resolved.selection,
		)
	}

	return resolved
}
