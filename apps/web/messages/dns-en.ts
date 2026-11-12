import type { dnsBn } from "./dns-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const dnsEn: Same<typeof dnsBn> = {
  Dns: {
    meta: { title: "DNS zones", detailTitle: "DNS records" },
    heading: "DNS zones",
    awsNote:
      "DNS zones run on Amazon Route 53, a global AWS service. A changed record can take some time to spread across the world.",
    flagOff: {
      title: "DNS zones are coming soon",
      body: "This service is not open in your market yet. You will be able to change records here once it opens.",
    },
    empty: {
      title: "No DNS zones yet",
      body: "Make your first zone below with the name of your domain. When it is ready you can change its A, AAAA, CNAME, MX, TXT, SRV and CAA records.",
    },
    status: {
      pending: "Being created",
      pending_delegation: "Waiting for name servers",
      delegated: "Name servers set",
      removing: "Being deleted",
      removed: "Deleted",
      failed: "Problem",
    },
    create: {
      title: "New DNS zone",
      intro:
        "Make a DNS zone for your domain on Amazon Route 53. When the zone is ready you set the name servers we give you at the registrar of your domain.",
      name: "Zone name (your domain)",
      nameHint: "For example example.com. Do not type http:// or a path.",
      declareTitle: "Confirmation",
      declare: "I confirm that I control this domain.",
      price:
        "A zone runs for 30 days. The price is shown on the next step, and nothing is charged until you confirm.",
      notDelegated:
        "If the name servers are not set within 14 days, we send two notices and then remove the zone.",
      registeredHere:
        "The zone of a domain registered with us cannot be made from here yet. Write to support.",
      submit: "Go to review",
      fieldError: {
        invalid_name:
          "The zone name is not valid. Use English letters, digits and hyphens, for example example.com.",
        taken: "Another zone has this name.",
        registered_here:
          "This domain is registered with us. Its zone cannot be made from here yet.",
        required: "Confirm to go on.",
        unavailable: "The price of this service is not set now. Please try later.",
      },
    },
    order: { open: "Open the zone" },
    state: {
      creating: "Creating",
      active: "Running",
      stopped: "Stopped",
      suspended: "Suspended",
      destroyed: "Deleted",
      failed: "Problem",
    },
    list: {
      caption: "Your DNS zones",
      name: "Zone name",
      state: "State",
      records: "Records",
      unknownRecords: "Not known",
      manage: "View records",
    },
    detail: {
      back: "All DNS zones",
      notFound: {
        title: "This zone was not found",
        body: "Check the link, or go back to the list of all DNS zones.",
      },
      nameServers: {
        title: "Name servers",
        body: "Set these name servers at the registrar of your domain, so that the records of this zone work.",
        none: "The name servers are not ready yet. They appear here when the zone is running.",
        steps:
          "Steps: 1) Sign in at the registrar of your domain. 2) Open the page that changes the name servers of the domain. 3) Remove the current name servers and enter the ones below. 4) Save. The change takes some time to spread.",
      },
      delegation: {
        pending: "The zone is being created. The name servers appear here within a minute.",
        pending_delegation:
          "The records work on the internet after you set the name servers at the registrar. If they are not set within 14 days, we send two notices and then remove the zone.",
        delegated: "The name servers are set and the records work.",
        removing: "The request to delete the zone was taken. It is deleted after approval.",
      },
      destroy: {
        title: "Delete the zone",
        body: "When you delete a zone, all its records leave Amazon Route 53 and your domain stops using this zone. We keep the list of records. You may need to sign in again, and our team approves the deletion before it is done.",
        button: "Delete the zone",
        dialogTitle: "Delete this zone?",
        dialogBody: "Type the name of the zone to confirm. A deleted zone cannot be brought back.",
      },
      notEditable: {
        creating: "The zone is still being created. You can change records when it is ready.",
        busy: "A change is on its way. You can change records again when it is finished.",
        state: "Records cannot be changed in this state.",
      },
      change: {
        working: "Your change is being applied. The list updates within a minute.",
        done: "The last change was applied.",
        failed:
          "The last change was not applied. Check the record and try again, or write to support.",
      },
      stale: {
        title: "The list of records cannot be shown now",
        body: "We are not sure the list is right, so we stopped instead of showing a wrong list. Changing records is off. Write to support.",
      },
      noRecords: "This zone has none of your records yet.",
      table: {
        caption: "Records of the zone",
        name: "Name",
        type: "Type",
        ttl: "TTL (seconds)",
        value: "Value",
        actions: "Actions",
        readOnly: "Read-only",
        edit: "Edit",
        delete: "Delete",
        deleteLabel: "Delete the {type} record {name}",
        editLabel: "Edit the {type} record {name}",
      },
      form: {
        addTitle: "Add a record",
        editTitle: "Edit a record",
        name: "Name",
        nameHint:
          "Type only the first part, for example www. Type @ for the zone itself. A name that starts with * covers every subdomain.",
        type: "Type",
        ttl: "TTL (seconds)",
        ttlHint: "60 to 86400. After a change, others may keep the old value for this long.",
        values: "Value",
        valuesHint: "Type each value on its own line.",
        submitAdd: "Add the record",
        submitEdit: "Save the change",
        cancel: "Cancel",
        typeHint: {
          A: "One IPv4 address, for example 203.0.113.10.",
          AAAA: "One IPv6 address, for example 2001:db8::1.",
          CNAME: "One host name, for example app.example.net. No other record can have this name.",
          MX: "A priority and a mail server, for example 10 mail.example.net.",
          TXT: "Plain text, for example v=spf1 -all. Do not type quotation marks.",
          SRV: "Priority, weight, port and host, for example 10 5 5060 sip.example.net. The name is _service._protocol.",
          CAA: 'Flags, tag and value, for example 0 issue "letsencrypt.org".',
        },
      },
      done: {
        added: "The request to add the record was taken. It shows in the list within a minute.",
        changed:
          "The request to change the record was taken. It shows in the list within a minute.",
        removed: "The request to delete the record was taken. It leaves the list within a minute.",
      },
    },
    done: {
      destroyQueued: "The request to delete the zone was taken.",
      approval: "The zone is deleted after our team approves it.",
    },
    error: {
      unauthenticated: "Your session has ended. Please sign in again.",
      flag_off: "This service is not open for you yet.",
      validation: "Some details are wrong. Fix the marked fields and try again.",
      rate_limited: "Too many requests in a short time. Please wait a moment and try again.",
      not_found: "This was not found.",
      not_allowed: "This cannot be done while the zone is in this state.",
      fresh_sign_in_required: "Please sign in again for this action.",
      name_mismatch: "The name you typed does not match the name of the zone.",
      busy: "Another change is on its way. Try again when it is finished.",
      conflict: "A record with this name and type exists, or this name cannot hold this type.",
      limit_reached: "The zone has reached its limit of records. Delete some records first.",
      unavailable: "We could not finish this now. Nothing was changed. Please try again shortly.",
    },
    field: {
      invalid_name: "The name can hold letters, digits, hyphens and underscores only.",
      outside_zone: "This name is outside this zone.",
      too_long: "The name is too long.",
      apex_cname: "The name of the zone itself cannot have a CNAME.",
      apex_read_only: "The NS and SOA records of the zone itself cannot be changed.",
      srv_name:
        "The name of an SRV record must look like _service._protocol, for example _sip._tcp.",
      unsupported_type: "This type of record is not supported.",
      out_of_range: "The TTL must be a whole number from 60 to 86400.",
      required: "Give at least one value.",
      too_many: "There are too many values.",
      single_value: "A CNAME can have one value only.",
      duplicate: "The same value is there twice.",
      points_at_itself: "The CNAME points at its own name.",
      invalid_value: "The value is not valid.",
      invalid_ipv4: "This is not a valid IPv4 address.",
      invalid_ipv6: "This is not a valid IPv6 address.",
      invalid_hostname: "This is not a valid host name.",
      invalid_mx: "Type a priority and a mail server, for example 10 mail.example.net.",
      invalid_priority: "The priority must be from 0 to 65535.",
      invalid_srv: "Type a priority, a weight, a port and a host.",
      invalid_number: "Priority, weight and port must be from 0 to 65535.",
      invalid_char: "Only English letters, digits and signs are allowed here.",
      already_quoted: "Type it without quotation marks. We add them.",
      empty: "The value cannot be empty.",
      invalid_caa: "Type flags, a tag and a value.",
      invalid_flags: "The flags must be 0 or 128.",
      invalid_tag: "The tag must be issue, issuewild or iodef.",
      exists: "A record with this name and type exists already. Press “Edit” to change it.",
      cname_conflict:
        "No other record can share the name of a CNAME, and a CNAME cannot take the name of another record.",
      zone_full: "The zone has reached its limit of records.",
    },
  },
};
