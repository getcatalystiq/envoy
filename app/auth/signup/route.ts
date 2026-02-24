import { signup } from "@/lib/queries/oauth";
import { jsonResponse } from "@/lib/utils";
import { renderSignupForm, renderSignupSuccess } from "@/lib/oauth-html";

export async function GET() {
  const html = renderSignupForm();
  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  const isForm = contentType.includes("form");

  let orgName: string | undefined;
  let email: string | undefined;
  let password: string | undefined;
  let firstName: string | undefined;
  let lastName: string | undefined;

  if (isForm) {
    const formData = await request.formData();
    orgName = (formData.get("org_name") as string) || undefined;
    email = (formData.get("email") as string) || undefined;
    password = (formData.get("password") as string) || undefined;
    firstName = (formData.get("first_name") as string) || undefined;
    lastName = (formData.get("last_name") as string) || undefined;
  } else {
    const data = await request.json();
    orgName = data.org_name;
    email = data.email;
    password = data.password;
    firstName = data.first_name;
    lastName = data.last_name;
  }

  if (!orgName) {
    if (isForm) {
      return new Response(renderSignupForm("Organization name is required"), {
        headers: { "Content-Type": "text/html" },
      });
    }
    return jsonResponse({ error: "org_name is required" }, 400);
  }
  if (!email) {
    if (isForm) {
      return new Response(renderSignupForm("Email is required"), {
        headers: { "Content-Type": "text/html" },
      });
    }
    return jsonResponse({ error: "email is required" }, 400);
  }
  if (!password || password.length < 8) {
    if (isForm) {
      return new Response(
        renderSignupForm("Password must be at least 8 characters"),
        { headers: { "Content-Type": "text/html" } }
      );
    }
    return jsonResponse(
      { error: "password must be at least 8 characters" },
      400
    );
  }

  let result;
  try {
    result = await signup(orgName, email, password, { firstName, lastName });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Signup failed";
    if (isForm) {
      return new Response(renderSignupForm(message), {
        headers: { "Content-Type": "text/html" },
      });
    }
    return jsonResponse({ error: message }, 400);
  }

  if (isForm) {
    const html = renderSignupSuccess(
      result.user.email,
      result.organization.name
    );
    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  }

  return jsonResponse(
    {
      organization: {
        id: result.organization.id,
        name: result.organization.name,
      },
      user: {
        id: result.user.id,
        email: result.user.email,
        first_name: result.user.first_name,
        last_name: result.user.last_name,
        role: result.user.role,
      },
    },
    201
  );
}
