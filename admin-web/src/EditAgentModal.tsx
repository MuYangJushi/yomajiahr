import {
  ModalForm,
  ProFormRadio,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
} from "@ant-design/pro-components";
import { message } from "antd";
import { updateAgent, type AgentRow, type Skill } from "./api";

interface Props {
  agent: AgentRow | null;
  skills: Skill[];
  onClose: () => void;
  onUpdated: () => void;
}

export default function EditAgentModal({ agent, skills, onClose, onUpdated }: Props) {
  return (
    <ModalForm
      key={agent?.id || "closed"}
      title={`修改数字员工：${agent?.name || ""}`}
      open={Boolean(agent)}
      initialValues={agent || undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modalProps={{ destroyOnClose: true }}
      onFinish={async (values) => {
        if (!agent) return false;
        try {
          await updateAgent(agent.id, {
            name: values.name,
            role: values.role,
            persona: values.persona,
            skills: values.skills,
          });
          message.success("数字员工已更新");
          onUpdated();
          return true;
        } catch (err: any) {
          message.error(err?.response?.data?.error || err.message || "更新失败");
          return false;
        }
      }}
    >
      <ProFormText name="id" label="ID" disabled />
      <ProFormText name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]} />
      <ProFormRadio.Group
        name="role"
        label="岗位"
        options={[
          { label: "员工面（只读）", value: "employee" },
          { label: "管理面（可写）", value: "admin" },
        ]}
        rules={[{ required: true }]}
      />
      <ProFormTextArea name="persona" label="人设" placeholder="一句话描述该数字员工的职责与风格" />
      <ProFormSelect
        name="skills"
        label="分配技能"
        mode="multiple"
        rules={[{ required: true, message: "至少分配一个技能" }]}
        options={skills.map((s) => ({ label: s.name, value: s.name, title: s.description }))}
      />
    </ModalForm>
  );
}
