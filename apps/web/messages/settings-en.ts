import type { settingsBn } from "./settings-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const settingsEn: Same<typeof settingsBn> = {
  Settings: {
    profile: {
      meta: { title: "Profile" },
      heading: "Profile",
      intro: "Change your name, language, e-mail address and phone number here.",
      toSecurity: "Password and security",
      details: {
        title: "Name and language",
        name: "Full name",
        nameHint: "This name is used on invoices and in our messages to you.",
        locale: "Language",
        localeBn: "বাংলা",
        localeEn: "English",
        save: "Save",
        saved: "Your profile was saved.",
      },
      billing: {
        title: "Billing details",
        intro:
          "These details are printed as the buyer on the tax invoice (Mushak 6.3). Every field is optional. If you leave them out, the invoice shows “-” for the address and the number.",
        summary: {
          empty: "No billing details have been entered yet.",
          filled:
            "The details below are printed on new invoices. Invoices already issued do not change.",
        },
        name: "Name on the invoice",
        nameHint: "If you leave it empty, the name of your profile is used. 2 to 120 characters.",
        address: "Address",
        addressHint: "In Bangla or English. 5 to 300 characters, in one paragraph.",
        bin: "BIN",
        binHint: "Only for a VAT-registered business. 13 digits.",
        binDisclaimer:
          "You are responsible for the BIN you enter; it appears on your tax invoices.",
        freshHint:
          "To set, change or remove the BIN, you must have signed in within the last 10 minutes; if not, we ask you to sign in again first.",
        privacy:
          "Only you can see these numbers, and they are printed on your own invoices. We keep them out of logs and e-mails.",
        save: "Save billing details",
        saved: "Your billing details were saved. New invoices will show them.",
        error: {
          invalid: "The details in this field are not correct.",
          billingName: {
            invalid: "The name has a character that is not allowed.",
            too_short: "The name must have at least 2 characters.",
            too_long: "The name can have at most 120 characters.",
          },
          billingAddress: {
            invalid: "The address has a character that is not allowed.",
            too_short: "The address must have at least 5 characters.",
            too_long: "The address can have at most 300 characters.",
          },
          customerBin: {
            invalid: "A BIN has exactly 13 digits.",
          },
        },
      },
      email: {
        title: "E-mail",
        current: "Current e-mail",
        newLabel: "New e-mail",
        newHint: "We send a code to the new address. The e-mail changes only after you enter it.",
        sendCode: "Send code",
        codeLabel: "6-digit code from the e-mail",
        confirm: "Change e-mail",
        sent: "A code was sent to the new address.",
        changed: "Your e-mail was changed.",
      },
      phone: {
        title: "Phone number",
        current: "Current number",
        none: "No number has been verified yet",
        verified: "Verified",
        newLabel: "New mobile number",
        newHint: "For example 01XXXXXXXXX. We send a code to this number.",
        sendCode: "Send code",
        codeLabel: "6-digit code from the SMS",
        confirm: "Change number",
        sent: "A code was sent",
        changed: "Your phone number was changed.",
      },
    },
    security: {
      meta: { title: "Security" },
      heading: "Password and security",
      intro: "You need your current password to change it.",
      toProfile: "Back to the profile",
      password: {
        title: "Change password",
        current: "Current password",
        new: "New password",
        newHint: "At least 12 characters. Simple or well-known passwords are refused.",
        confirm: "Enter the new password again",
        submit: "Change password",
        changed: "Your password was changed.",
      },
      totp: {
        title: "Authenticator app (two-step sign-in)",
        intro:
          "Use Google Authenticator, Microsoft Authenticator or any similar app. When it is on, signing in needs the 6-digit code from the app as well as your password. It must be on before you buy anything.",
        statusOn: "On",
        statusOff: "Off",
        start: "Switch on the authenticator",
        step1:
          "1. Add a new account in the app and scan the QR code. If you cannot scan it, type the secret key below, or open the link if the app is on this phone.",
        qrLabel: "QR code to scan with your authenticator app",
        secretLabel: "Secret key",
        secretNote:
          "The key is shown only once and is hidden after 60 seconds. Do not share it. We do not store it.",
        openApp: "Open in the authenticator app",
        hidden: "The secret key was hidden for your safety. Start again if you need it.",
        step2: "2. Enter the 6-digit code the app shows now.",
        code: "Code from the app",
        confirm: "Check the code and switch on",
        enabled: "The authenticator is on. Signing in now needs the code.",
        disableTitle: "Switch off the authenticator",
        disableBody:
          "When it is off, signing in no longer needs the code, and you cannot buy anything new until you switch it on again.",
        disable: "Switch off the authenticator",
        disabled: "The authenticator was switched off.",
      },
    },
    fresh: {
      note: "To change your e-mail, phone, password or authenticator you must have signed in within the last 10 minutes.",
      signIn: "Sign in again",
    },
    notOpen: {
      title: "This change is not open yet",
      body: "This service is not switched on yet. You can make the change here once it is.",
    },
    error: {
      unauthenticated: "Your session has ended. Sign in again.",
      forbidden: "This action could not be done.",
      fresh_sign_in_required: "For your safety, sign in again and then try once more.",
      validation: "Some details are wrong. Correct the marked fields and try again.",
      rate_limited: "Too many requests in a short time. Wait a little and try again.",
      wrong_password: "The current password is not correct.",
      invalid_code: "The code is not correct. Check it and try again.",
      expired_code: "The code has expired. Ask for a new one.",
      unavailable: "We could not finish this now. Try again in a little while.",
    },
    field: {
      invalid: "The details in this field are not correct.",
      required: "Fill in this field.",
      too_short: "The password must be at least 12 characters.",
      too_long: "The text in this field is too long.",
      too_common: "This password is too well known. Choose another.",
      same_as_email: "The password cannot be the same as your e-mail.",
      repeated: "Do not repeat the same characters.",
      same_as_current: "The new password must differ from the current one.",
      mismatch: "The two passwords do not match.",
      wrong: "This is not correct.",
      same: "This is your current e-mail.",
      malformed: "Enter the 6-digit code.",
      expired: "This has expired.",
      already_on: "The authenticator is already on.",
      not_on: "The authenticator is not on.",
    },
  },
  AccountSetup: {
    title: "Finish your account setup before you buy",
    body: "Our service runs on a prepaid wallet, so no documents are needed. Just finish these three steps.",
    steps: {
      email: "{n}. Verify your e-mail",
      phone: "{n}. Verify your mobile number",
      totp: "{n}. Switch on an authenticator app",
    },
    done: "Done",
    todo: "To do",
    action: {
      email: "Check your e-mail",
      phone: "Verify your mobile number",
      totp: "Switch on the authenticator",
    },
  },
};
