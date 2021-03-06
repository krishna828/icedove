/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Dependencies:
// gPrefBranch, gBrandBundle, gMessengerBundle should already be defined
// gatherTextUnder from utilityOverlay.js

const kPhishingNotSuspicious = 0;
const kPhishingWithIPAddress = 1;
const kPhishingWithMismatchedHosts = 2;

//////////////////////////////////////////////////////////////////////////////
// isEmailScam --> examines the message currently loaded in the message pane
//                 and returns true if we think that message is an e-mail scam.
//                 Assumes the message has been completely loaded in the message pane (i.e. OnMsgParsed has fired)
// aUrl: nsIURI object for the msg we want to examine...
//////////////////////////////////////////////////////////////////////////////
function isMsgEmailScam(aUrl)
{
  var isEmailScam = false; 
  if (!aUrl || !gPrefBranch.getBoolPref("mail.phishing.detection.enabled"))
    return isEmailScam;

  try {
    // nsIMsgMailNewsUrl.folder can throw an NS_ERROR_FAILURE, especially if
    // we are opening an .eml file.
    var folder = aUrl.folder;

    // Ignore NNTP and RSS messages.
    if (folder.server.type == 'nntp' || folder.server.type == 'rss')
      return isEmailScam;

    // Also ignore messages in Sent/Drafts/Templates/Outbox.
    const nsMsgFolderFlags = Components.interfaces.nsMsgFolderFlags;
    let outgoingFlags = nsMsgFolderFlags.SentMail | nsMsgFolderFlags.Drafts |
                        nsMsgFolderFlags.Templates | nsMsgFolderFlags.Queue;
    if (folder.isSpecialFolder(outgoingFlags, true))
      return isEmailScam;

  } catch (ex) {
    if (ex.result != Components.results.NS_ERROR_FAILURE)
      throw ex;
  }

  // loop through all of the link nodes in the message's DOM, looking for phishing URLs...
  var msgDocument = document.getElementById('messagepane').contentDocument;
  var index;

  // examine all links...
  var linkNodes = msgDocument.links;
  for (index = 0; index < linkNodes.length && !isEmailScam; index++)
    isEmailScam = isPhishingURL(linkNodes[index], true);

  // if an e-mail contains a non-addressbook form element, then assume the message is
  // a phishing attack. Legitimate sites should not be using forms inside of e-mail
  if (!isEmailScam)
  {
    var forms = msgDocument.getElementsByTagName("form");
    for (index = 0; index < forms.length && !isEmailScam; index++)
      isEmailScam = forms[index].action != "" && !/^addbook:/.test(forms[index].action);
  }

  // we'll add more checks here as our detector matures....
  return isEmailScam;
}

//////////////////////////////////////////////////////////////////////////////
// isPhishingURL --> examines the passed in linkNode and returns true if we think
//                   the URL is an email scam.
// aLinkNode: the link node to examine
// aSilentMode: don't prompt the user to confirm
// aHref: optional href for XLinks
//////////////////////////////////////////////////////////////////////////////

function isPhishingURL(aLinkNode, aSilentMode, aHref)
{
  if (!gPrefBranch.getBoolPref("mail.phishing.detection.enabled"))
    return false;

  var phishingType = kPhishingNotSuspicious;
  var href = aHref || aLinkNode.href;
  if (!href)
    return false;

  var linkTextURL = {};
  var isPhishingURL = false;

  var hrefURL = Services.io.newURI(href, null, null);
  
  // only check for phishing urls if the url is an http or https link.
  // this prevents us from flagging imap and other internally handled urls
  if (hrefURL.schemeIs('http') || hrefURL.schemeIs('https'))
  {
    var ipAddress = hostNameIsIPAddress(hrefURL.host);
    if (ipAddress && !isLocalIPAddress(ipAddress))
      phishingType = kPhishingWithIPAddress;
    else if (misMatchedHostWithLinkText(aLinkNode, hrefURL, linkTextURL))
      phishingType = kPhishingWithMismatchedHosts;

    isPhishingURL = phishingType != kPhishingNotSuspicious;

    if (!aSilentMode && isPhishingURL) // allow the user to override the decision
      isPhishingURL = confirmSuspiciousURL(phishingType, hrefURL.host);
  }

  return isPhishingURL;
}

//////////////////////////////////////////////////////////////////////////////
// helper methods in support of isPhishingURL
//////////////////////////////////////////////////////////////////////////////

function misMatchedHostWithLinkText(aLinkNode, aHrefURL, aLinkTextURL)
{
  var linkNodeText = gatherTextUnder(aLinkNode);

  // gatherTextUnder puts a space between each piece of text it gathers,
  // so strip the spaces out (see bug 326082 for details).
  linkNodeText = linkNodeText.replace(/ /g, "");

  // only worry about http and https urls
  if (linkNodeText)
  {
    // does the link text look like a http url?
     if (linkNodeText.search(/(^http:|^https:)/) != -1)
     {
       var linkTextURL  = Services.io.newURI(linkNodeText, null, null);
       aLinkTextURL.value = linkTextURL;
       // compare hosts, but ignore possible www. prefix
       return !(aHrefURL.host.replace(/^www\./, "") == aLinkTextURL.value.host.replace(/^www\./, ""));
     }
  }

  return false;
}

// returns the unobscured host (if there is one), otherwise null
function hostNameIsIPAddress(aHostName)
{
  // TODO: Add Support for IPv6

  var index;

  // scammers frequently obscure the IP address by encoding each component as octal, hex
  // or in some cases a mix match of each. The IP address could also be represented as a DWORD.

  // break the IP address down into individual components.
  var ipComponents = aHostName.split(".");

  // if we didn't find at least 4 parts to our IP address it either isn't a numerical IP
  // or it is encoded as a dword
  if (ipComponents.length < 4)
  {
    // Convert to a binary to test for possible DWORD.
    var binaryDword = parseInt(aHostName).toString(2);
    if (isNaN(binaryDword))
      return null;

    // convert the dword into its component IP parts.
    ipComponents =
    [
      (aHostName >> 24) & 255,
      (aHostName >> 16) & 255,
      (aHostName >>  8) & 255,
      (aHostName & 255)
    ];
  }
  else
  {
    for (index = 0; index < ipComponents.length; ++index)
    {
      // by leaving the radix parameter blank, we can handle IP addresses
      // where one component is hex, another is octal, etc.
      ipComponents[index] = parseInt(ipComponents[index]);
    }
  }

  // make sure each part of the IP address is in fact a number
  for (index = 0; index < ipComponents.length; ++index)
    if (isNaN(ipComponents[index])) // if any part of the IP address is not a number, then we can safely return
      return null;

  // only return unobscured host name if we are looking at an IPv4 host name
  var hostName = ipComponents.join(".");
  return isIPv4HostName(hostName) ? hostName : null;
}

function isIPv4HostName(aHostName)
{
  var ipv4HostRegExp = new RegExp(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);  // IPv4
  // treat 0.0.0.0 as an invalid IP address
  return ipv4HostRegExp.test(aHostName) && aHostName != '0.0.0.0';
}

// returns true if the user confirms the URL is a scam
function confirmSuspiciousURL(aPhishingType, aSuspiciousHostName)
{
  var brandShortName = gBrandBundle.getString("brandShortName");
  var titleMsg = gMessengerBundle.getString("confirmPhishingTitle");
  var dialogMsg;

  switch (aPhishingType)
  {
    case kPhishingWithIPAddress:
    case kPhishingWithMismatchedHosts:
      dialogMsg = gMessengerBundle.getFormattedString("confirmPhishingUrl" + aPhishingType, [brandShortName, aSuspiciousHostName], 2);
      break;
    default:
      return false;
  }

  var buttons = Services.prompt.STD_YES_NO_BUTTONS +
                Services.prompt.BUTTON_POS_1_DEFAULT;
  return Services.prompt.confirmEx(window, titleMsg, dialogMsg, buttons, "", "", "", "", {}); /* the yes button is in position 0 */
}

// returns true if the IP address is a local address.
function isLocalIPAddress(unobscuredHostName)
{
  var ipComponents = unobscuredHostName.split(".");

  return ipComponents[0] == 10 ||
         (ipComponents[0] == 192 && ipComponents[1] == 168) ||
         (ipComponents[0] == 169 && ipComponents[1] == 254) ||
         (ipComponents[0] == 172 && ipComponents[1] >= 16 && ipComponents[1] < 32);
}
