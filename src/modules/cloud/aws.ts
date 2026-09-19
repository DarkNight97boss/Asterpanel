import { createHash, createHmac } from "node:crypto";
import { CloudError, SLUG, type CloudCredentials, type CloudProvider, type CloudServer, type Http } from "./types";

/**
 * Amazon EC2 — Query API signed with Signature Version 4, no SDK.
 * The Ubuntu image is resolved by AWS itself from Canonical's public SSM
 * parameter, so there is no per-region AMI table to keep up to date.
 */

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const sha = (data: string) => createHash("sha256").update(data).digest("hex");
/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone). */
const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

export function signV4(input: { method: string; host: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: string; region: string; service: string; accessKeyId: string; secretAccessKey: string; now: Date }): { authorization: string; amzDate: string; canonicalQuery: string } {
  const amzDate = input.now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")])), host: input.host, "x-amz-date": amzDate };
  const names = Object.keys(headers).sort();
  const canonicalQuery = Object.keys(input.query).sort().map((k) => `${enc(k)}=${enc(input.query[k])}`).join("&");
  const canonical = [input.method, input.path, canonicalQuery, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), sha(input.body)].join("\n");
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), input.service), "aws4_request");
  return { authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${createHmac("sha256", key).update(toSign).digest("hex")}`, amzDate, canonicalQuery };
}

async function ec2(c: CloudCredentials, http: Http, region: string, params: Record<string, string>): Promise<string> {
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new CloudError("Invalid AWS region");
  const host = `ec2.${region}.amazonaws.com`;
  const body = new URLSearchParams({ Version: "2016-11-15", ...params }).toString();
  const contentType = "application/x-www-form-urlencoded; charset=utf-8";
  const { authorization, amzDate } = signV4({ method: "POST", host, path: "/", query: {}, headers: { "content-type": contentType }, body, region, service: "ec2", accessKeyId: c.accessKeyId ?? "", secretAccessKey: c.secretAccessKey ?? "", now: new Date() });
  const res = await http(`https://${host}/`, { method: "POST", body, headers: { "Content-Type": contentType, "X-Amz-Date": amzDate, Authorization: authorization }, signal: AbortSignal.timeout(30_000) });
  const xml = await res.text();
  if (!res.ok) throw new CloudError(/<Message>([^<]*)<\/Message>/.exec(xml)?.[1] ?? `AWS answered ${res.status}`);
  return xml;
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? "";

function view(xml: string, id: string): CloudServer {
  const state = /<instanceState>\s*<code>\d+<\/code>\s*<name>([^<]*)<\/name>/.exec(xml)?.[1] ?? "";
  if (!state || state === "terminated" || state === "shutting-down") return { id, status: "gone", ip: "" };
  return { id, ip: tag(xml, "ipAddress"), status: state === "running" ? "running" : state === "stopped" || state === "stopping" ? "stopped" : "starting" };
}

export const aws: CloudProvider = {
  id: "aws",
  name: "Amazon Web Services (EC2)",
  website: "https://aws.amazon.com/ec2/",
  fields: [
    { name: "accessKeyId", label: "Access key ID", type: "text", help: "An IAM user limited to ec2:RunInstances, DescribeInstances, TerminateInstances, CreateTags and ssm:GetParameters." },
    { name: "secretAccessKey", label: "Secret access key", type: "password" },
    { name: "securityGroupId", label: "Security group ID", type: "text", help: "Must allow inbound 80 and 443 (and 53 if nodes serve DNS). Empty = the VPC default, which blocks them.", optional: true },
    { name: "subnetId", label: "Subnet ID", type: "text", help: "A public subnet. Empty = the default VPC.", optional: true },
  ],
  regions: [["eu-south-1", "Milan"], ["eu-central-1", "Frankfurt"], ["eu-west-1", "Ireland"], ["eu-west-3", "Paris"], ["us-east-1", "N. Virginia"], ["us-west-2", "Oregon"], ["ap-southeast-1", "Singapore"]].map(([id, label]) => ({ id, label: `${label} (${id})` })),
  sizes: [["t3.small", "2 vCPU · 2 GB"], ["t3.medium", "2 vCPU · 4 GB"], ["t3.large", "2 vCPU · 8 GB"], ["m6i.large", "2 vCPU · 8 GB"], ["m6i.xlarge", "4 vCPU · 16 GB"]].map(([id, label]) => ({ id, label: `${id} — ${label}` })),

  async test(c, http) {
    await ec2(c, http, "us-east-1", { Action: "DescribeRegions" });
    return "Connected";
  },
  async create(c, s, http) {
    if (!SLUG.test(s.size)) throw new CloudError("Invalid instance type");
    const group: Record<string, string> = c.securityGroupId ? { "NetworkInterface.1.DeviceIndex": "0", "NetworkInterface.1.AssociatePublicIpAddress": "true", "NetworkInterface.1.SecurityGroupId.1": c.securityGroupId, ...(c.subnetId ? { "NetworkInterface.1.SubnetId": c.subnetId } : {}) } : c.subnetId ? { SubnetId: c.subnetId } : {};
    const xml = await ec2(c, http, s.region, {
      Action: "RunInstances",
      ImageId: "resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
      InstanceType: s.size,
      MinCount: "1",
      MaxCount: "1",
      UserData: Buffer.from(s.bootScript, "utf8").toString("base64"),
      "BlockDeviceMapping.1.DeviceName": "/dev/sda1",
      "BlockDeviceMapping.1.Ebs.VolumeSize": "60",
      "BlockDeviceMapping.1.Ebs.VolumeType": "gp3",
      "BlockDeviceMapping.1.Ebs.DeleteOnTermination": "true",
      "MetadataOptions.HttpTokens": "required",
      "TagSpecification.1.ResourceType": "instance",
      "TagSpecification.1.Tag.1.Key": "Name",
      "TagSpecification.1.Tag.1.Value": s.name,
      "TagSpecification.1.Tag.2.Key": "managed-by",
      "TagSpecification.1.Tag.2.Value": "asterpanel",
      // Same token for the same node: a retried request cannot start a second instance.
      ClientToken: `aster-${s.name}`.slice(0, 64),
      ...group,
    });
    const id = tag(xml, "instanceId");
    if (!/^i-[0-9a-f]+$/.test(id)) throw new CloudError("AWS did not return an instance id");
    return { id, status: "starting", ip: "" };
  },
  async get(c, id, region, http) {
    if (!/^i-[0-9a-f]+$/.test(id)) throw new CloudError("Invalid instance id");
    try {
      return view(await ec2(c, http, region, { Action: "DescribeInstances", "InstanceId.1": id }), id);
    } catch (err) {
      if (err instanceof CloudError && /does not exist|InvalidInstanceID/i.test(err.message)) return { id, status: "gone", ip: "" };
      throw err;
    }
  },
  async destroy(c, id, region, http) {
    if (!/^i-[0-9a-f]+$/.test(id)) throw new CloudError("Invalid instance id");
    await ec2(c, http, region, { Action: "TerminateInstances", "InstanceId.1": id }).catch((err) => {
      if (!(err instanceof CloudError && /does not exist|InvalidInstanceID/i.test(err.message))) throw err;
    });
  },
};
