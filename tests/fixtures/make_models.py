"""Builds tiny stand-in ONNX models with the exact input/output signatures of
a ContentVec encoder and an RVC v2 (f0) voice export, so the in-app AI
pipeline can be tested end-to-end without shipping real voice models.

The fake voice model sings a sine wave at the f0 it is given, which lets the
test check that pitch tracking, key shifting, chunking and tensor plumbing are
all correct.

    pip install onnx numpy && python tests/fixtures/make_models.py
"""
import os
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

HERE = os.path.dirname(__file__)
DIM = 768
HOP_OUT = 400  # 40 kHz model: 400 output samples per 10 ms frame


def encoder():
    w = numpy_helper.from_array(np.full((1, 1, 320), 1 / 320, np.float32), "w")
    shape = numpy_helper.from_array(np.array([1, 1, DIM], np.int64), "shape")
    nodes = [
        helper.make_node("Conv", ["source", "w"], ["c"], strides=[320], kernel_shape=[320]),
        helper.make_node("Transpose", ["c"], ["t"], perm=[0, 2, 1]),
        helper.make_node("Expand", ["t", "shape"], ["embed"]),
    ]
    g = helper.make_graph(
        nodes, "contentvec_stub",
        [helper.make_tensor_value_info("source", TensorProto.FLOAT, [1, 1, "N"])],
        [helper.make_tensor_value_info("embed", TensorProto.FLOAT, [1, "T", DIM])],
        [w, shape],
    )
    return helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)], ir_version=8)


def voice():
    c = lambda name, arr: numpy_helper.from_array(np.array(arr), name)
    inits = [
        c("tile", np.array([1, 1, HOP_OUT], np.int64)),
        c("flat", np.array([1, 1, -1], np.int64)),
        c("inv_sr", np.array(2 * np.pi / (HOP_OUT * 100), np.float32)),
        c("axis", np.array(2, np.int64)),
        c("zero", np.array(0.0, np.float32)),
    ]
    nodes = [
        helper.make_node("Unsqueeze", ["pitchf", "axis"], ["pf3"]),
        helper.make_node("Tile", ["pf3", "tile"], ["pft"]),
        helper.make_node("Reshape", ["pft", "flat"], ["fup"]),
        helper.make_node("Mul", ["fup", "inv_sr"], ["dphi"]),
        helper.make_node("CumSum", ["dphi", "axis"], ["phi"]),
        helper.make_node("Sin", ["phi"], ["s"]),
        # Touch every other input so the signature is enforced.
        helper.make_node("ReduceSum", ["phone"], ["ps"], keepdims=0),
        helper.make_node("ReduceSum", ["rnd"], ["rs"], keepdims=0),
        helper.make_node("Cast", ["pitch"], ["pc"], to=TensorProto.FLOAT),
        helper.make_node("ReduceSum", ["pc"], ["pcs"], keepdims=0),
        helper.make_node("Cast", ["ds"], ["dc"], to=TensorProto.FLOAT),
        helper.make_node("Cast", ["phone_lengths"], ["lc"], to=TensorProto.FLOAT),
        helper.make_node("Sum", ["ps", "rs", "pcs"], ["t1"]),
        helper.make_node("Mul", ["t1", "zero"], ["t2"]),
        helper.make_node("Add", ["s", "t2"], ["audio"]),
    ]
    T = "T"
    g = helper.make_graph(
        nodes, "rvc_stub",
        [
            helper.make_tensor_value_info("phone", TensorProto.FLOAT, [1, T, DIM]),
            helper.make_tensor_value_info("phone_lengths", TensorProto.INT64, [1]),
            helper.make_tensor_value_info("pitch", TensorProto.INT64, [1, T]),
            helper.make_tensor_value_info("pitchf", TensorProto.FLOAT, [1, T]),
            helper.make_tensor_value_info("ds", TensorProto.INT64, [1]),
            helper.make_tensor_value_info("rnd", TensorProto.FLOAT, [1, 192, T]),
        ],
        [helper.make_tensor_value_info("audio", TensorProto.FLOAT, [1, 1, "S"])],
        inits,
    )
    return helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)], ir_version=8)


for name, model in [("encoder_stub.onnx", encoder()), ("voice_stub.onnx", voice())]:
    onnx.checker.check_model(model)
    onnx.save(model, os.path.join(HERE, name))
    print("wrote", name)
