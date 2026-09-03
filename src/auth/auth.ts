import { betterAuth } from "better-auth"
import { APIError } from "better-auth/api"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { admin as adminPlugin, bearer, openAPI, organization } from "better-auth/plugins"

import { env } from "../config/env"
import { db } from "../db/client"
import {
	account,
	invitation,
	jwks,
	member,
	organization as organizationTable,
	organizationRole,
	session,
	user,
	verification,
} from "../db/schema"
import {
	sendEmailVerificationEmail,
	sendPasswordResetEmail,
	sendWorkspaceInvitationEmail,
} from "../mail/emails"
import { billingService } from "../modules/billing/billing.service"
import { AppError } from "../shared/errors"
import { defaultWorkspaceId } from "./active-workspace"
import { ac, roles } from "./permissions"

/** Localhost only, for the same reason as DEFAULT_ORIGINS in src/api/app.ts. */
const DEFAULT_TRUSTED_ORIGINS = ["http://localhost:*", "https://localhost:*"]

/**
 * Entitlement failures raised by our own services have to leave Better Auth's
 * handler as a Better Auth error, or the plugin turns them into an opaque 500.
 */
function toApiError(error: unknown): never {
	if (error instanceof AppError) {
		throw new APIError(error.status === 402 ? "PAYMENT_REQUIRED" : "FORBIDDEN", {
			code: error.code,
			message: error.message,
			details: error.details,
		})
	}
	throw error
}

/**
 * Better Auth owns identity only: users, sessions, accounts, social login,
 * password credentials, and the workspace membership primitives from the
 * organization plugin.
 *
 * Ragenta's own authorization (who may act on which resource) and entitlement
 * (what the plan allows) live in src/modules/*, behind the API middleware. Do
 * not move product endpoints into plugins — that is exactly what makes the
 * reference service hard to layer.
 */
export const auth = betterAuth({
	appName: "Ragenta",
	baseURL: env.apiBaseUrl,
	basePath: "/v1/auth",
	secret: env.auth.secret,
	trustedOrigins: [...DEFAULT_TRUSTED_ORIGINS, ...env.trustedOrigins],

	database: drizzleAdapter(db, {
		provider: "pg",
		// The adapter only sees what is listed here.
		schema: {
			user,
			session,
			account,
			verification,
			jwks,
			organization: organizationTable,
			member,
			invitation,
			organizationRole,
		},
	}),

	advanced: {
		trustedProxyHeaders: true,
		ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
		// Only enable cross-subdomain cookies when a real domain is configured;
		// on localhost a Domain attribute breaks the cookie entirely.
		...(env.auth.cookieDomain
			? { crossSubDomainCookies: { enabled: true, domain: env.auth.cookieDomain } }
			: {}),
	},

	rateLimit: {
		window: 10,
		max: 100,
	},

	emailAndPassword: {
		enabled: true,
		sendResetPassword: async ({ user: recipient, url }) => {
			await sendPasswordResetEmail(recipient.email, url)
		},
	},

	emailVerification: {
		sendOnSignUp: true,
		autoSignInAfterVerification: true,
		sendVerificationEmail: async ({ user: recipient, url }) => {
			await sendEmailVerificationEmail(recipient.email, url)
		},
	},

	account: {
		accountLinking: {
			enabled: true,
			trustedProviders: ["google"],
			// `requireLocalEmailVerified` is deliberately left at Better Auth's
			// default (true). The reference service relaxes it to rescue legacy
			// unverified rows it imported; Ragenta has no such rows, and relaxing
			// it here would open pre-registration account takeover — sign up with
			// someone's address, wait for them to arrive via Google, inherit the
			// account.
		},
	},

	socialProviders: env.auth.google
		? {
				google: {
					clientId: env.auth.google.clientId,
					clientSecret: env.auth.google.clientSecret,
				},
			}
		: undefined,

	databaseHooks: {
		session: {
			create: {
				/**
				 * Seed the session's workspace at creation. CREATE ONLY, never
				 * update: clearing the active workspace is how the client sends a
				 * user to the workspace picker, and seeding on update would undo
				 * that on the next write. See ./active-workspace.ts.
				 */
				before: async (newSession) => {
					if (newSession.activeOrganizationId) return
					const workspaceId = await defaultWorkspaceId(newSession.userId)
					if (!workspaceId) return
					return { data: { activeOrganizationId: workspaceId } }
				},
			},
		},
	},

	plugins: [
		openAPI({
			path: "/docs",
			info: { title: "Ragenta Auth", description: "Identity endpoints", version: "1.0.0" },
		}),
		bearer(),
		adminPlugin({
			adminUserIds: env.adminUserIds,
		}),
		organization({
			// Teams stay off: Ragenta's unit inside a workspace is the Project.
			ac,
			roles,
			organizationHooks: {
				async beforeCreateInvitation({ invitation: pending }) {
					await billingService
						.assertSeatAvailable(pending.organizationId)
						.catch(toApiError)
				},
				async beforeAddMember({ member: incoming }) {
					await billingService
						.assertSeatAvailable(incoming.organizationId)
						.catch(toApiError)
				},
			},
			async sendInvitationEmail(data) {
				await sendWorkspaceInvitationEmail({
					to: data.email,
					workspaceName: data.organization.name,
					inviterName: data.inviter.user.name,
					inviterEmail: data.inviter.user.email,
					role: data.role,
					invitationId: data.id,
				})
			},
		}),
	],
})

export type Auth = typeof auth
export type AuthSession = typeof auth.$Infer.Session
export type AuthUser = AuthSession["user"]
